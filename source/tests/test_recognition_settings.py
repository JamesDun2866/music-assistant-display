import asyncio
import json
import os
from pathlib import Path
import stat
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiosendspin.noise.keys import Identity
from sendspin_karaoke_source.config import SourceError
from sendspin_karaoke_source.recognition import Recognition
from sendspin_karaoke_source.recognition_settings import NAME, RecognitionSettings, read_settings, write_settings
from test_source import PrivateWorkspace, eventually


class RememberedRecognitionTests(PrivateWorkspace, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.create_workspace()
        self.identity = Identity.generate()
        self.subjects = []
        self.addAsyncCleanup(self.close_all)

    async def close_all(self):
        for subject in self.subjects:
            await subject.close()

    def subject(self):
        result = Recognition(SimpleNamespace(consumers={}, observers=set()), self.identity,
                             state_dir=self.path, publish=Mock(), recognize=AsyncMock())
        self.subjects.append(result)
        return result

    async def enable(self, subject, threshold=-45):
        with patch("importlib.util.find_spec", return_value=object()):
            return await subject.enable(threshold)

    async def test_new_or_old_install_without_consent_remains_off(self):
        subject = self.subject()
        with patch("importlib.util.find_spec") as dependency:
            await subject.start()
            dependency.assert_not_called()
        self.assertFalse(subject.status()["enabled"])
        self.assertFalse(subject.status()["remembered_enabled"])
        self.assertIsNone(subject.status()["settings_error"])
        await subject.close()
        self.assertFalse((self.path / NAME).exists())

    async def test_enable_threshold_restart_and_shutdown_preserve_choice(self):
        subject = self.subject()
        await subject.start()
        await self.enable(subject, -52)
        self.assertTrue(read_settings(self.path)["enabled"])
        await subject.close()
        self.assertTrue(read_settings(self.path)["enabled"])
        restored = self.subject()
        with patch("importlib.util.find_spec", return_value=object()):
            await restored.start()
        self.assertTrue(restored.enabled)
        self.assertEqual(restored.state, "idle")
        self.assertEqual(restored.threshold_dbfs, -52)
        self.assertEqual(restored.source_id, subject.source_id)
        await restored.disable()
        again = self.subject()
        await again.start()
        self.assertFalse(again.enabled)
        self.assertFalse(again.remembered_enabled)
        self.assertEqual(read_settings(self.path)["silence_dbfs"], -52)

    async def test_missing_extra_keeps_remembered_optin_but_core_off_and_disable_clears_it(self):
        subject = self.subject()
        await self.enable(subject)
        await subject.close()
        restored = self.subject()
        with patch("importlib.util.find_spec", return_value=None):
            await restored.start()
        self.assertFalse(restored.enabled)
        self.assertTrue(restored.remembered_enabled)
        self.assertEqual(restored.settings_error, "restore_failed")
        await restored.disable()
        self.assertFalse(read_settings(self.path)["enabled"])
        self.assertFalse(restored.remembered_enabled)
        self.assertIsNone(restored.settings_error)

    async def test_corrupt_oversized_duplicate_unknown_fields_fail_closed(self):
        for raw in (
            b"x", b"x" * 513, b'{"version":1,"enabled":true,"enabled":false,"silence_dbfs":-45}',
            b'{"version":true,"enabled":true,"silence_dbfs":-45}',
            b'{"version":1,"enabled":true,"silence_dbfs":NaN}',
            b'{"version":1,"enabled":true,"silence_dbfs":-45,"filename":"bad"}',
        ):
            with self.subTest(raw=raw[:80]):
                (self.path / NAME).write_bytes(raw)
                (self.path / NAME).chmod(0o600)
                subject = self.subject()
                await subject.start()
                self.assertFalse(subject.enabled)
                self.assertEqual(subject.settings_error, "restore_failed")
                await subject.disable()
                self.assertFalse(read_settings(self.path)["enabled"])

    async def test_write_failure_is_explicit_enable_stays_off_disable_clears_runtime(self):
        subject = self.subject()
        with patch.object(subject.settings, "save", AsyncMock(side_effect=OSError("disk"))):
            with self.assertRaisesRegex(SourceError, "could not be saved"):
                await self.enable(subject)
        self.assertFalse(subject.enabled)
        self.assertEqual(subject.settings_error, "save_failed")
        await self.enable(subject)
        with patch.object(subject.settings, "save", AsyncMock(side_effect=OSError("disk"))):
            with self.assertRaisesRegex(SourceError, "previous or requested opt-in"):
                await subject.disable()
        self.assertFalse(subject.enabled)
        self.assertTrue(subject.remembered_enabled)
        self.assertTrue(read_settings(self.path)["enabled"])

    async def test_explicit_commands_are_idempotent_and_enabling_again_does_not_rearm(self):
        subject = self.subject()
        first = await self.enable(subject, -50)
        second = await self.enable(subject, -50)
        self.assertEqual(first["generation"], second["generation"])
        self.assertEqual(read_settings(self.path), {"version": 1, "enabled": True, "silence_dbfs": -50})
        with self.assertRaisesRegex(SourceError, "Disable recognition"):
            await self.enable(subject, -55)
        await subject.disable()
        await subject.disable()
        self.assertFalse(subject.enabled)
        self.assertFalse(read_settings(self.path)["enabled"])

    async def test_enable_and_disable_are_serialized_without_touching_capture(self):
        subject = self.subject()
        entered, release = asyncio.Event(), asyncio.Event()
        original = subject.settings.save
        calls = []
        async def save(enabled, threshold):
            calls.append(enabled)
            if enabled:
                entered.set()
                await release.wait()
            await original(enabled, threshold)
        with patch.object(subject.settings, "save", save):
            enabling = asyncio.create_task(self.enable(subject))
            await entered.wait()
            disabling = asyncio.create_task(subject.disable())
            await asyncio.sleep(0)
            self.assertEqual(calls, [True])
            self.assertFalse(subject.enabled)
            release.set()
            await asyncio.gather(enabling, disabling)
        self.assertEqual(calls, [True, False])
        self.assertFalse(subject.enabled)
        self.assertFalse(read_settings(self.path)["enabled"])
        self.assertEqual(subject.owner.consumers, {})

    async def test_cancelled_or_timed_out_disk_worker_never_commits_late_or_spawns_overlap(self):
        for timeout in (False, True):
            store = RecognitionSettings(self.path)
            release, entered = threading.Event(), threading.Event()
            def delayed(directory, value, cancelled):
                entered.set()
                release.wait(5)
                write_settings(directory, value, cancelled)
            try:
                with patch("sendspin_karaoke_source.recognition_settings.write_settings", delayed), \
                        patch("sendspin_karaoke_source.recognition_settings.IO_SECONDS", .03 if timeout else 3):
                    task = asyncio.create_task(store.save(True, -45))
                    await eventually(entered.is_set)
                    if not timeout:
                        task.cancel()
                    with self.assertRaises(TimeoutError if timeout else asyncio.CancelledError):
                        await task
                    with self.assertRaisesRegex(SourceError, "still retiring"):
                        await store.save(False, -45)
                    self.assertFalse((self.path / NAME).exists())
            finally:
                release.set()
                await eventually(lambda: store.pending.done())
            self.assertFalse((self.path / NAME).exists())
            self.assertEqual(list(self.path.iterdir()), [])

    async def test_atomic_regular_private_file_and_cancelled_commit(self):
        store = RecognitionSettings(self.path)
        await store.save(True, -45)
        await store.save(False, -55)
        self.assertEqual(read_settings(self.path), {"version": 1, "enabled": False, "silence_dbfs": -55})
        self.assertEqual([item.name for item in self.path.iterdir()], [NAME])
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE((self.path / NAME).stat().st_mode), 0o600)
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(SourceError):
            write_settings(self.path, {"version": 1, "enabled": True, "silence_dbfs": -45}, cancelled)
        self.assertFalse(read_settings(self.path)["enabled"])

    @unittest.skipUnless(os.name == "posix", "POSIX symlink and permission checks")
    async def test_unsafe_file_or_directory_fails_closed(self):
        subject = self.subject()
        target = self.path / "untouched"
        target.write_text("untouched")
        (self.path / NAME).symlink_to(target)
        await subject.start()
        self.assertFalse(subject.enabled)
        with self.assertRaises(SourceError):
            await subject.disable()
        self.assertEqual(target.read_text(), "untouched")
        (self.path / NAME).unlink()
        await self.enable(subject)
        (self.path / NAME).chmod(0o644)
        with self.assertRaises(SourceError):
            read_settings(self.path)
        (self.path / NAME).chmod(0o600)
        self.path.chmod(0o755)
        with self.assertRaises(SourceError):
            read_settings(self.path)
        self.path.chmod(0o700)


if __name__ == "__main__":
    unittest.main()
