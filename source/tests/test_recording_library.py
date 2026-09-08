import os
from pathlib import Path
import shutil
import sys
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
from sendspin_karaoke_source.recording_library import LibraryError, RecordingLibrary, album_metadata, text


@unittest.skipUnless(os.name == "posix" and hasattr(os, "O_NOFOLLOW"), "Linux descriptor safety")
class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.path = SOURCE / "tests" / (".library-" + uuid.uuid4().hex)
        self.path.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree, self.path)
        (self.path / "recordings").mkdir(mode=0o700)
        self.library = RecordingLibrary(self.path, "a" * 64)
        self.addCleanup(self.library.close)

    def recording(self, *, extension="wav", content=b"synthetic audio"):
        name = "20260908T120000.000000Z-" + uuid.uuid4().hex + "." + extension
        path = self.path / "recordings" / name
        path.write_bytes(content)
        path.chmod(0o600)
        return path

    def test_labels_and_album_are_persistent_non_destructive(self):
        path = self.recording()
        before = path.read_bytes()
        item = self.library.list()["items"][0]
        updated = self.library.update(item["id"], item["revision"], label="New display label")
        self.assertEqual(updated["id"], item["id"])
        self.assertNotEqual(updated["revision"], item["revision"])
        self.assertEqual(path.read_bytes(), before)
        with self.assertRaises(LibraryError):
            self.library.update(item["id"], item["revision"], label="Stale")
        album = {"title": "Fixture", "artist": "Test", "catalog": None,
                 "provenance": {"kind": "recognition", "revision": None}}
        updated = self.library.update(updated["id"], updated["revision"], album=album)
        self.assertEqual(updated["album"], {"title": "Fixture", "artist": "Test"})
        self.library.close()
        reopened = RecordingLibrary(self.path, "a" * 64)
        self.addCleanup(reopened.close)
        again = reopened.list()["items"][0]
        self.assertEqual(again, updated)
        self.assertEqual(path.read_bytes(), before)

    def test_only_single_link_final_owned_files(self):
        good = self.recording()
        active = self.recording()
        active.with_name(active.name + ".partial").write_bytes(b"pending")
        hardlink = self.recording()
        os.link(hardlink, self.path / "other-link")
        symlink = self.path / "recordings" / ("20260908T120000.000000Z-" + uuid.uuid4().hex + ".wav")
        symlink.symlink_to(good)
        unsafe = self.recording()
        unsafe.chmod(0o644)
        (self.path / "recordings" / "arbitrary.wav").write_bytes(b"not final")
        page = self.library.list()
        self.assertEqual([item["id"] for item in page["items"]], [self.library._id(good.name)])

    def test_pagination_scan_budget_and_expired_cursor(self):
        for index in range(260):
            (self.path / "recordings" / f"ignored-{index}").touch()
        page = self.library.list()
        self.assertEqual(page["items"], [])
        self.assertIsNotNone(page["nextCursor"])
        final = self.library.list(page["nextCursor"])
        self.assertIsNone(final["nextCursor"])
        with self.assertRaises(LibraryError) as error:
            self.library.list(page["nextCursor"])
        self.assertEqual(error.exception.category, "restart-needed")
        page = self.library.list()
        self.library.clock = lambda: 10**12
        with self.assertRaises(LibraryError):
            self.library.list(page["nextCursor"])

    def test_cursor_invalidates_on_directory_mutation(self):
        self.recording()
        page = self.library.list(limit=1)
        self.recording()
        with self.assertRaises(LibraryError) as error:
            self.library.list(page["nextCursor"])
        self.assertEqual(error.exception.category, "restart-needed")

    def test_download_bounded_and_rejects_modified_file(self):
        path = self.recording(content=b"x" * 150000)
        item = self.library.list()["items"][0]
        download = self.library.download(item["id"], item["revision"])
        self.addCleanup(download.close)
        self.assertEqual(len(download.read()), 65536)
        with path.open("ab") as handle:
            handle.write(b"changed")
        with self.assertRaises(LibraryError):
            download.read()
        with self.assertRaises(LibraryError):
            self.library.download(item["id"], item["revision"])

    def test_replacement_and_directory_swap_fail_closed(self):
        path = self.recording()
        item = self.library.list()["items"][0]
        self.library.update(item["id"], item["revision"], label="Original file")
        path.unlink()
        path.write_bytes(b"replacement")
        path.chmod(0o600)
        with self.assertRaises(LibraryError):
            self.library.download(item["id"], item["revision"])
        replacement = self.library.list()["items"][0]
        self.assertNotEqual(replacement["label"], "Original file")
        directory = self.path / "recordings"
        directory.rename(self.path / "old-recordings")
        directory.mkdir(mode=0o700)
        with self.assertRaises(LibraryError):
            self.library.list()

    def test_independent_scan_offsets_and_bounded_contexts(self):
        for _ in range(4):
            self.recording()
        first = self.library.list(limit=1)
        second = self.library.list(limit=1)
        self.assertEqual(first["items"], second["items"])
        self.assertEqual(len(self.library.list(first["nextCursor"])["items"]), 3)
        self.assertEqual(len(self.library.list(second["nextCursor"])["items"]), 3)
        self.assertEqual(len(self.library.list()["items"]), 4)
        for _ in range(8):
            self.library.list(limit=1)
        with self.assertRaises(LibraryError) as error:
            self.library.list(limit=1)
        self.assertEqual(error.exception.category, "busy")

    def test_metadata_symlink_and_invalid_labels_rejected(self):
        self.recording()
        item = self.library.list()["items"][0]
        for label in ("../escape", "x\nsecret", "", "x" * 121, "x\\y"):
            with self.assertRaises(LibraryError):
                self.library.update(item["id"], item["revision"], label=label)
        (self.path / "recording-metadata").symlink_to(self.path / "recordings", target_is_directory=True)
        with self.assertRaises((LibraryError, OSError)):
            self.library.update(item["id"], item["revision"], label="safe")

    def test_complete_download_and_source_bound_id(self):
        content = b"test" * 40000
        self.recording(content=content)
        item = self.library.list()["items"][0]
        download = self.library.download(item["id"], item["revision"])
        self.addCleanup(download.close)
        result = bytearray()
        while block := download.read():
            self.assertLessEqual(len(block), 65536)
            result.extend(block)
        self.assertEqual(result, content)
        other = RecordingLibrary(self.path, "b" * 64)
        self.addCleanup(other.close)
        self.assertNotEqual(other.list()["items"][0]["id"], item["id"])

    def test_large_library_and_restart_do_not_expire_recording_ids(self):
        for _ in range(1100):
            self.recording()
        page = self.library.list()
        first = page["items"][0]
        count = len(page["items"])
        while page["nextCursor"] is not None:
            page = self.library.list(page["nextCursor"])
            count += len(page["items"])
        self.assertEqual(count, 1100)
        self.library.close()
        reopened = RecordingLibrary(self.path, "a" * 64)
        self.addCleanup(reopened.close)
        transfer = reopened.download(first["id"], first["revision"])
        try:
            self.assertEqual(transfer.read(), b"synthetic audio")
        finally:
            transfer.close()
        updated = reopened.update(first["id"], first["revision"], label="Still available")
        self.assertEqual(updated["id"], first["id"])

    def test_maximum_unicode_metadata_fits_the_sidecar_budget(self):
        self.recording()
        first = self.library.list()["items"][0]
        updated = self.library.update(first["id"], first["revision"], label="\U0001f3b5" * 120)
        album = {
            "title": "\U0001f3b5" * 256, "artist": "\U0001f3b5" * 256,
            "catalog": {"kind": "collection", "id": "9" * 15, "country": "gb"},
            "provenance": {"kind": "correction", "revision": "a" * 128},
        }
        updated = self.library.update(first["id"], updated["revision"], album=album)
        self.assertEqual(updated["album"]["title"], album["title"])
        self.assertEqual(self.library.list()["items"][0], updated)


class AlbumValidationTests(unittest.TestCase):
    def test_ids_resolve_without_a_cache_and_reject_other_sources(self):
        library = RecordingLibrary(SOURCE, "a" * 64)
        for format in ("wav", "flac"):
            name = f"20260908T123456.789012Z-{'a' * 32}.{format}"
            identifier = library._id(name)
            self.assertEqual(len(identifier), 64)
            self.assertEqual(library._name(identifier), name)
            other = RecordingLibrary(SOURCE, "b" * 64)
            with self.assertRaises(LibraryError):
                other._name(identifier)

    def test_text_limits_count_unicode_scalars(self):
        self.assertEqual(text("\U0001f3b5" * 120, 120, label=True), "\U0001f3b5" * 120)
        with self.assertRaises(LibraryError):
            text("\U0001f3b5" * 121, 120, label=True)
        self.assertEqual(text("\U0001f3b5" * 256), "\U0001f3b5" * 256)

    def test_album_contract_rejects_unbounded_or_extra_data(self):
        value = {"title": "Fixture", "artist": "Synthetic", "catalog": None,
                 "provenance": {"kind": "recognition", "revision": None}}
        self.assertEqual(album_metadata(value), value)
        for change in ({"raw": "no"}, {"catalog": {"url": "https://example.com"}},
                       {"title": "x" * 257}, {"provenance": {"kind": [], "revision": None}}):
            with self.assertRaises(LibraryError):
                album_metadata({**value, **change})


if __name__ == "__main__":
    unittest.main()
