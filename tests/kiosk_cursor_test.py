"""Hardware-free tests for the opt-in labwc cursor configuration helper."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from xml.parsers import expat
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("kiosk_cursor", ROOT / "scripts" / "configure-kiosk-cursor.py")
cursor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cursor)


class CursorConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "user"
        self.system = Path(self.temp.name) / "system"
        self.target = self.home / "labwc" / "rc.xml"

    def test_preserves_xml_bytes_and_other_rules_on_enable_remove(self):
        for root in ("labwc_config", "openbox_config"):
            with self.subTest(root=root):
                original = (
                    '<?xml version="1.0" encoding="UTF-8"?>\r\n'
                    f'<{root}>\r\n<!-- Personal caf\u00e9 settings -->\r\n'
                    '<keyboard><keybind key="W-r"><action name="Reconfigure"/></keybind></keyboard>\r\n'
                    '<windowRules><windowRule identifier="ordinary-browser">'
                    '<action name="Maximize"/></windowRule></windowRules>\r\n'
                    f'</{root}>\r\n'
                ).encode()
                enabled = cursor.transform(original, True)
                self.assertEqual(enabled.replace(cursor.BLOCK, b""), original)
                rules = ElementTree.fromstring(enabled).findall("windowRules/windowRule")
                self.assertEqual(len(rules), 2)
                self.assertEqual(rules[-1].attrib, {"identifier": cursor.APP_ID, "event": "onFirstMap"})
                self.assertEqual(rules[-1][0].attrib, {"name": "HideCursor"})
                self.assertEqual(cursor.transform(enabled, True), enabled)
                self.assertEqual(cursor.transform(enabled, False), original)
                self.assertEqual(cursor.transform(original, False), original)

    def test_empty_rules_section_and_non_ascii_before_insertion(self):
        original = b"<labwc_config><!-- \xc3\xa9 --><windowRules/></labwc_config>"
        result = cursor.transform(original, True)
        self.assertEqual(result.replace(cursor.BLOCK, b""), original)
        self.assertEqual(len(ElementTree.fromstring(result).findall("windowRules/windowRule")), 1)

    def test_marker_text_in_cdata_or_nested_xml_is_never_deleted_or_activated(self):
        for original in [
            b"<labwc_config><note><![CDATA[" + cursor.BLOCK + b"]]></note></labwc_config>",
            b"<labwc_config><note>" + cursor.BLOCK + b"</note></labwc_config>",
        ]:
            for enable in [True, False]:
                with self.subTest(original=original, enable=enable):
                    self.target.parent.mkdir(parents=True, exist_ok=True)
                    self.target.write_bytes(original)
                    with self.assertRaises(ValueError):
                        cursor.configure(self.home, [self.system], enable)
                    self.assertEqual(self.target.read_bytes(), original)
                    self.assertFalse(self.target.with_name("rc.xml.before-sendspin-karaoke-cursor").exists())

    def test_removal_preserves_later_unmanaged_rules_for_same_identifier(self):
        original = b"<labwc_config></labwc_config>"
        unmanaged = b'<windowRules><windowRule identifier="sendspin-karaoke-kiosk"><action name="Maximize"/></windowRule></windowRules>'
        enabled = cursor.transform(original, True).replace(b"</labwc_config>", unmanaged + b"</labwc_config>")
        with self.assertRaisesRegex(ValueError, "unmanaged"):
            cursor.transform(enabled, True)
        self.assertEqual(cursor.transform(enabled, False), original.replace(b"</labwc_config>", unmanaged + b"</labwc_config>"))

    def test_refuses_malformed_xml_markers_entities_and_unmanaged_conflict(self):
        for data in [
            b"<labwc_config>",
            b"<unexpected></unexpected>",
            b"<labwc_config/>",
            b"<labwc_config>" + cursor.BEGIN + b"</labwc_config>",
            b"<labwc_config>" + cursor.BLOCK * 2 + b"</labwc_config>",
            b"<labwc_config>" + cursor.BLOCK.replace(b"HideCursor", b"WarpCursor") + b"</labwc_config>",
            b'<!DOCTYPE labwc_config [<!ENTITY x "value">]><labwc_config></labwc_config>',
            b'<labwc_config><windowRules><windowRule identifier="sendspin-karaoke-kiosk"/></windowRules></labwc_config>',
            b'<labwc_config><windowRules><windowRule><identifier>sendspin-karaoke-kiosk</identifier></windowRule></windowRules></labwc_config>',
        ]:
            with self.subTest(data=data):
                with self.assertRaises((ValueError, expat.ExpatError)):
                    cursor.transform(data, True)

    def test_keeps_backup_and_user_edits_and_atomic_file_permissions(self):
        self.target.parent.mkdir(parents=True)
        original = b"<labwc_config>\n<!-- mine -->\n</labwc_config>\n"
        self.target.write_bytes(original)
        if os.name != "nt":
            self.target.chmod(0o640)
        self.assertTrue(cursor.configure(self.home, [self.system], True))
        backup = self.target.with_name("rc.xml.before-sendspin-karaoke-cursor")
        self.assertEqual(backup.read_bytes(), original)
        self.assertFalse(cursor.configure(self.home, [self.system], True))
        updated = self.target.read_bytes().replace(b"<!-- mine -->", b"<!-- later edit -->")
        self.target.write_bytes(updated)
        self.assertTrue(cursor.configure(self.home, [self.system], False))
        self.assertEqual(self.target.read_bytes(), original.replace(b"<!-- mine -->", b"<!-- later edit -->"))
        self.assertEqual(backup.read_bytes(), original)
        self.assertFalse(cursor.configure(self.home, [self.system], False))
        self.assertEqual(list(self.target.parent.glob(".rc.xml.cursor-*")), [])
        if os.name != "nt":
            self.assertEqual(self.target.stat().st_mode & 0o777, 0o640)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)

    def test_inherits_first_system_config_instead_of_erasing_desktop_defaults(self):
        inherited = self.system / "labwc" / "rc.xml"
        inherited.parent.mkdir(parents=True)
        original = b"<labwc_config><keyboard/><theme><name>Pi</name></theme></labwc_config>"
        inherited.write_bytes(original)
        self.assertTrue(cursor.configure(self.home, [self.system], True))
        self.assertEqual(self.target.read_bytes().replace(cursor.BLOCK, b""), original)
        self.assertEqual(inherited.read_bytes(), original)
        cursor.configure(self.home, [self.system], False)
        self.assertEqual(self.target.read_bytes(), original)

    def test_stock_pi_merge_mode_adds_only_user_rule_not_duplicate_system_defaults(self):
        process = Path(self.temp.name) / "1256"
        process.mkdir()
        (process / "comm").write_text("labwc\n")
        (process / "cmdline").write_bytes(b"/usr/bin/labwc\0-m\0")
        inherited = self.system / "labwc" / "rc.xml"
        inherited.parent.mkdir(parents=True)
        original = b'<labwc_config><keyboard/><windowRules><windowRule identifier="panel"><action name="Maximize"/></windowRule></windowRules></labwc_config>'
        inherited.write_bytes(original)
        with patch.object(cursor.Path, "iterdir", return_value=iter([process])), \
                patch.object(cursor.os, "getuid", return_value=process.stat().st_uid, create=True):
            merged = cursor.check_session_config()
        self.assertIs(merged, True)
        self.assertTrue(cursor.configure(self.home, [self.system], True, merge_config=merged))
        user = self.target.read_bytes()
        self.assertNotIn(b"keyboard", user)
        self.assertNotIn(b"panel", user)
        self.assertEqual(len(ElementTree.fromstring(user).findall("windowRules/windowRule")), 1)
        self.assertEqual(inherited.read_bytes(), original)
        self.assertFalse(cursor.configure(self.home, [self.system], True, merge_config=merged))
        self.assertTrue(cursor.configure(self.home, [self.system], False, merge_config=merged))
        self.assertEqual(self.target.read_bytes(), b"<labwc_config>\n</labwc_config>\n")
        self.assertEqual(inherited.read_bytes(), original)

    def test_merged_mode_preserves_existing_user_xml_and_all_system_layers(self):
        layers = [self.system, Path(self.temp.name) / "other-system"]
        for index, directory in enumerate(layers):
            config = directory / "labwc" / "rc.xml"
            config.parent.mkdir(parents=True)
            config.write_bytes(f"<labwc_config><!-- system {index} --><keyboard/></labwc_config>".encode())
        system_before = [(directory / "labwc" / "rc.xml").read_bytes() for directory in layers]
        self.target.parent.mkdir(parents=True)
        user = b"<labwc_config><!-- user --><theme><name>Mine</name></theme></labwc_config>"
        self.target.write_bytes(user)
        cursor.configure(self.home, layers, True, merge_config=True)
        self.assertEqual(self.target.read_bytes().replace(cursor.BLOCK, b""), user)
        self.assertFalse(cursor.configure(self.home, layers, True, merge_config=True))
        self.target.write_bytes(self.target.read_bytes().replace(b"Mine", b"Later"))
        cursor.configure(self.home, layers, False, merge_config=True)
        self.assertEqual(self.target.read_bytes(), user.replace(b"Mine", b"Later"))
        self.assertEqual([(directory / "labwc" / "rc.xml").read_bytes() for directory in layers], system_before)

    def test_merged_mode_refuses_duplicate_system_kiosk_rule_but_allows_user_undo(self):
        inherited = self.system / "labwc" / "rc.xml"
        inherited.parent.mkdir(parents=True)
        inherited.write_bytes(b'<labwc_config><windowRules><windowRule identifier="sendspin-karaoke-kiosk"/></windowRules></labwc_config>')
        with self.assertRaisesRegex(ValueError, "unmanaged"):
            cursor.configure(self.home, [self.system], True, merge_config=True)
        self.assertFalse(self.home.exists())
        self.target.parent.mkdir(parents=True)
        original = b"<labwc_config></labwc_config>"
        self.target.write_bytes(cursor.transform(original, True))
        cursor.configure(self.home, [self.system], False, merge_config=True)
        self.assertEqual(self.target.read_bytes(), original)

    def test_merged_duplicate_user_search_path_is_rejected_before_creating_file(self):
        with self.assertRaisesRegex(ValueError, "duplicate search path"):
            cursor.configure(self.home, [self.home], True, merge_config=True)
        self.assertFalse(self.home.exists())

    def test_removing_absent_config_does_not_create_files(self):
        self.assertFalse(cursor.configure(self.home, [self.system], False))
        self.assertFalse(self.home.exists())

    def test_invalid_user_xml_does_not_write_a_backup_or_change_file(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b"<invalid")
        with self.assertRaises(expat.ExpatError):
            cursor.configure(self.home, [self.system], True)
        self.assertEqual(self.target.read_bytes(), b"<invalid")
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])

    @unittest.skipIf(os.name == "nt", "Linux symlink safety")
    def test_refuses_symlink_target(self):
        self.target.parent.mkdir(parents=True)
        other = Path(self.temp.name) / "other.xml"
        other.write_bytes(b"<labwc_config></labwc_config>")
        self.target.symlink_to(other)
        with self.assertRaisesRegex(ValueError, "symlink"):
            cursor.configure(self.home, [self.system], True)
        self.assertEqual(other.read_bytes(), b"<labwc_config></labwc_config>")

    def test_version_guard_strips_epoch_and_uses_installed_package_status(self):
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if args[0].endswith("dpkg-query"):
                version = "0.9.7-1+rpt1" if args[-1] == "labwc" else "1:152.0.7977.75-1~deb13u1+rpt1"
                return subprocess.CompletedProcess(args, 0, f"installed\t{version}")
            return subprocess.CompletedProcess(args, 0)

        with patch.object(cursor.subprocess, "run", side_effect=run):
            cursor.check_versions()
        self.assertIn(["/usr/bin/dpkg", "--compare-versions", "0.9.7-1+rpt1", "ge", "0.9.7"], calls)
        self.assertIn(["/usr/bin/dpkg", "--compare-versions", "152.0.7977.75-1~deb13u1+rpt1", "ge", "152"], calls)
        with patch.object(cursor.subprocess, "run", side_effect=[
            subprocess.CompletedProcess([], 0, "installed\t0.8.3"),
            subprocess.CompletedProcess([], 1),
        ]):
            with self.assertRaisesRegex(ValueError, "labwc >= 0.9.7"):
                cursor.check_versions()

    def test_enable_checks_versions_before_configuration_but_remove_can_recover_after_downgrade(self):
        with patch.object(cursor.sys, "platform", "linux"), \
                patch.object(cursor.os, "geteuid", return_value=1000, create=True), \
                patch.object(cursor, "check_session_config"), \
                patch.object(cursor, "check_versions", side_effect=ValueError("unsupported")), \
                patch.object(cursor, "configure") as configure, \
                patch.object(cursor.sys, "argv", ["helper", "--enable"]):
            with self.assertRaisesRegex(ValueError, "unsupported"):
                cursor.main()
            configure.assert_not_called()
        with patch.object(cursor.sys, "platform", "linux"), \
                patch.object(cursor.os, "geteuid", return_value=1000, create=True), \
                patch.object(cursor, "check_session_config"), \
                patch.object(cursor, "check_versions") as versions, \
                patch.object(cursor.Path, "is_absolute", return_value=True), \
                patch.object(cursor, "configure", return_value=True) as configure, \
                patch.object(cursor.sys, "argv", ["helper", "--remove"]):
            cursor.main()
            versions.assert_not_called()
            self.assertFalse(configure.call_args.args[-1])

    def test_cli_requires_explicit_opt_in_and_rejects_root(self):
        with patch.object(cursor.sys, "argv", ["helper"]), self.assertRaises(SystemExit):
            cursor.main()
        with patch.object(cursor.sys, "platform", "linux"), \
                patch.object(cursor.os, "geteuid", return_value=0, create=True), \
                patch.object(cursor.sys, "argv", ["helper", "--enable"]), \
                patch.object(cursor, "configure") as configure:
            with self.assertRaisesRegex(ValueError, "WITHOUT sudo"):
                cursor.main()
            configure.assert_not_called()

    def test_refuses_running_custom_config_paths_without_printing_argv(self):
        process = Path(self.temp.name) / "123"
        process.mkdir()
        (process / "comm").write_text("labwc\n")
        for args in [
            [b"-c", b"private-path"], [b"--config=private-path"],
            [b"-Cprivate-path"], [b"--config-dir", b"private-path"],
        ]:
            with self.subTest(args=args):
                (process / "cmdline").write_bytes(b"\0".join([b"labwc", *args, b""]))
                with patch.object(cursor.Path, "iterdir", return_value=iter([process])), \
                        patch.object(cursor.os, "getuid", return_value=process.stat().st_uid, create=True):
                    with self.assertRaisesRegex(ValueError, "Custom labwc config paths"):
                        cursor.check_session_config()
        (process / "cmdline").write_bytes(b"labwc\0")
        with patch.object(cursor.Path, "iterdir", return_value=iter([process])), \
                patch.object(cursor.os, "getuid", return_value=process.stat().st_uid, create=True):
            self.assertIs(cursor.check_session_config(), False)

    def test_detects_long_merge_flag_and_refuses_ambiguous_sessions(self):
        processes = []
        for index, argument in enumerate([b"--merge-config", b""]):
            process = Path(self.temp.name) / str(100 + index)
            process.mkdir()
            (process / "comm").write_text("labwc\n")
            (process / "cmdline").write_bytes(b"labwc\0" + argument + b"\0")
            processes.append(process)
        with patch.object(cursor.Path, "iterdir", return_value=iter(processes[:1])), \
                patch.object(cursor.os, "getuid", return_value=processes[0].stat().st_uid, create=True):
            self.assertIs(cursor.check_session_config(), True)
        with patch.object(cursor.Path, "iterdir", return_value=iter(processes)), \
                patch.object(cursor.os, "getuid", return_value=processes[0].stat().st_uid, create=True):
            with self.assertRaisesRegex(ValueError, "disagree"):
                cursor.check_session_config()

    def test_no_active_desktop_does_not_guess_merge_mode_or_write_config(self):
        with patch.object(cursor.sys, "platform", "linux"), \
                patch.object(cursor.os, "geteuid", return_value=1000, create=True), \
                patch.object(cursor.Path, "iterdir", return_value=iter([])), \
                patch.object(cursor, "configure") as configure, \
                patch.object(cursor.sys, "argv", ["helper", "--enable"]):
            with self.assertRaisesRegex(ValueError, "No running labwc"):
                cursor.main()
            configure.assert_not_called()

    def test_main_passes_detected_merge_mode_to_configure(self):
        with patch.object(cursor.sys, "platform", "linux"), \
                patch.object(cursor.os, "geteuid", return_value=1000, create=True), \
                patch.object(cursor, "check_session_config", return_value=True), \
                patch.object(cursor, "check_versions"), \
                patch.object(cursor.Path, "read_text", return_value="--class=sendspin-karaoke-kiosk"), \
                patch.object(cursor.Path, "is_absolute", return_value=True), \
                patch.object(cursor, "configure", return_value=True) as configure, \
                patch.object(cursor.sys, "argv", ["helper", "--enable"]):
            cursor.main()
            self.assertIs(configure.call_args.kwargs["merge_config"], True)


if __name__ == "__main__":
    unittest.main()
