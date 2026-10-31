"""The distributable builder cannot accidentally ship agent data or mismatched pins."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

PRODUCT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("chainchat_windows_builder", PRODUCT / "installer/build_windows.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class InstallerSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ct-installer-source-")
        self.root = Path(self.temporary.name)
        self.pins = json.loads((PRODUCT / "openclaw/upstream-lock.json").read_text())
        pin = self.pins["openclaw"]
        self.files = {
            "package.json": json.dumps({"name": "cypher-tempre-chat", "version": "0.7.0"}),
            "server.mjs": "// fixture", "engine_bridge.py": "# fixture", "openclaw/launcher.mjs": "// fixture",
            "installer/windows-installer.cs": "// fixture", "installer/windows.manifest": "<fixture/>",
            "public/fonts/orbitron/Orbitron-Variable.ttf": "font fixture",
            "openclaw/upstream-lock.json": json.dumps(self.pins),
            "openclaw/runtime/package.json": json.dumps({"dependencies": {"openclaw": pin["version"]},
                "overrides": self.pins.get("dependencyOverrides", {})}),
            "openclaw/runtime/package-lock.json": json.dumps({"packages": {"node_modules/openclaw": {
                "version": pin["version"], "integrity": pin["integrity"], "resolved": pin["source"]},
                **{"node_modules/" + name: {"version": version} for name, version in self.pins.get("dependencyOverrides", {}).items()}}}),
        }

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, changes=None, extras=None):
        file = self.root / "source.zip"
        records = {**self.files, **(changes or {})}
        with zipfile.ZipFile(file, "w") as archive:
            for name, value in records.items():
                archive.writestr("cypher-tempre-chat/" + name, value)
            for name, value in (extras or {}).items():
                entry = zipfile.ZipInfo(name)
                entry.filename = name  # Preserve malicious raw backslashes on Windows too.
                archive.writestr(entry, value)
        return file

    def test_complete_pinned_source_is_accepted(self):
        package, prefix, pins = builder.inspect_payload(self.archive())
        self.assertEqual(package["version"], "0.7.0")
        self.assertEqual(prefix, "cypher-tempre-chat/")
        self.assertEqual(pins["openclaw"], self.pins["openclaw"])

    def test_private_state_paths_and_preinstalled_dependencies_are_rejected(self):
        for name in (".local/state.json", "chain/rings.jsonl", "tasks/private.json", "node_modules/secret/file.js", ".env", ".env.production", ".git/config", ".local/"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, "unsafe/private"):
                    builder.inspect_payload(self.archive(extras={"cypher-tempre-chat/" + name: "private"}))

    def test_traversal_rooted_and_windows_stream_paths_are_rejected(self):
        for name in ("cypher-tempre-chat/../escape", "/outside", "cypher-tempre-chat/C:/outside", "cypher-tempre-chat/file:stream", "cypher-tempre-chat/folder\\file"):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    builder.inspect_payload(self.archive(extras={name: "bad"}))

    def test_case_colliding_windows_files_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate Windows"):
            builder.inspect_payload(self.archive(extras={"cypher-tempre-chat/Server.mjs": "different"}))

    def test_symlink_members_are_rejected(self):
        file = self.archive()
        with zipfile.ZipFile(file, "a") as archive:
            entry = zipfile.ZipInfo("cypher-tempre-chat/link")
            entry.create_system = 3
            entry.external_attr = 0o120777 << 16
            archive.writestr(entry, "target")
        with self.assertRaisesRegex(ValueError, "unsafe/private"):
            builder.inspect_payload(file)

    def test_runtime_lock_version_integrity_and_source_must_match(self):
        lock = json.loads(self.files["openclaw/runtime/package-lock.json"])
        for field, value in (("version", "0.0.0"), ("integrity", "sha512-wrong"), ("resolved", "https://untrusted.example/module.tgz")):
            changed = copy.deepcopy(lock)
            changed["packages"]["node_modules/openclaw"][field] = value
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, "do not match"):
                    builder.inspect_payload(self.archive({"openclaw/runtime/package-lock.json": json.dumps(changed)}))

    def test_security_overrides_must_match_both_manifest_and_lock(self):
        package = json.loads(self.files["openclaw/runtime/package.json"])
        package["overrides"] = {**package["overrides"], "undici": "0.0.0"}
        with self.assertRaisesRegex(ValueError, "overrides and lockfile"):
            builder.inspect_payload(self.archive({"openclaw/runtime/package.json": json.dumps(package)}))
        lock = json.loads(self.files["openclaw/runtime/package-lock.json"])
        lock["packages"]["node_modules/undici"]["version"] = "0.0.0"
        with self.assertRaisesRegex(ValueError, "overrides and lockfile"):
            builder.inspect_payload(self.archive({"openclaw/runtime/package-lock.json": json.dumps(lock)}))


if __name__ == "__main__":
    unittest.main()
