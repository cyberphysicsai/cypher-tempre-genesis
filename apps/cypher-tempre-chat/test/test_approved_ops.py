"""Local approved-operator boundaries; synthetic source and isolated chain only."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

import approved_ops
import engine_bridge


class ApprovedOperatorSelectionTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="ct-approved-ops-selection-"))
        self.trust = Path(tempfile.mkdtemp(prefix="ct-approved-ops-trust-"))
        self.local_trust = mock.patch.object(approved_ops, "TRUST_ROOT", self.trust)
        self.local_trust.start()
        engine_bridge.op_init({"root": str(self.root), "name": "Approved selection fixture"})
        self.marker = self.root / "authored-ran.txt"
        self.source = ("from pathlib import Path\n"
                       "Path(__file__).with_name('authored-ran.txt').write_text('executed', encoding='utf-8')\n"
                       "OPS = {'Installed Faculty': lambda text, context: {'fixture': 'selected'}}\n").encode()
        (self.root / "active_ops.py").write_bytes(self.source)
        approved_ops.approve_source(self.root, hashlib.sha256(self.source).hexdigest(), confirmed=True)

    def tearDown(self):
        self.local_trust.stop()
        resolved = self.root.resolve()
        self.assertTrue(resolved.is_relative_to(Path(tempfile.gettempdir()).resolve()))
        self.assertTrue(resolved.name.startswith("ct-approved-ops-selection-"))
        shutil.rmtree(resolved)
        trust = self.trust.resolve()
        self.assertTrue(trust.is_relative_to(Path(tempfile.gettempdir()).resolve()))
        self.assertTrue(trust.name.startswith("ct-approved-ops-trust-"))
        shutil.rmtree(trust)

    def test_approved_module_is_not_loaded_for_unrelated_equipped_definition(self):
        self.assertFalse(self.marker.exists(), "Approval inspection must not execute authored source.")
        result = approved_ops.run_approved(self.root, ["Unrelated Unsupported Faculty"], "Synthetic prompt")
        self.assertEqual(result["computed"], {})
        self.assertFalse(self.marker.exists(), "An unrelated equipped definition must not load an approved module.")

    def test_matching_approved_faculty_loads_the_module_and_returns_actual_computation(self):
        result = approved_ops.run_approved(self.root, ["Installed Faculty"], "Synthetic prompt")
        self.assertEqual(result["computed"], {"Installed Faculty": {"fixture": "selected"}})
        self.assertTrue(self.marker.exists())

    def test_chain_carried_approval_without_local_anchor_cannot_execute(self):
        approved_ops._trust_record_path(self.root).unlink()
        self.assertTrue((self.root / "chain" / "operator-approval.json").exists())
        result = approved_ops.inspect_source(self.root)
        self.assertFalse(result["approved"])
        self.assertIn("installation", result["reason"])
        self.assertEqual(approved_ops.run_approved(self.root, ["Installed Faculty"], "Synthetic")["computed"], {})
        self.assertFalse(self.marker.exists())

    def test_fabricated_matching_receipt_and_manifest_do_not_create_local_authority(self):
        approved_ops._trust_record_path(self.root).unlink()
        manifest_path = self.root / "chain" / "operator-approval.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.pop("ring"); manifest.pop("ringHash")
        manifest["summary"] = "Synthetic donor claims local approval without recipient authorization."
        tc = engine_bridge.Timechain(self.root)
        forged = tc.seal("operator-code-approval", manifest)
        manifest_path.write_text(json.dumps({**manifest, "ring": forged["index"], "ringHash": forged["ring_hash"]}), encoding="utf-8")
        self.assertTrue(tc.verify()[0], "The fabricated chain is hash-valid; hashes alone must not authorize code.")
        self.assertFalse(approved_ops.inspect_source(self.root)["approved"])
        self.assertFalse(self.marker.exists())

    def test_untrusted_manifest_cannot_probe_its_claimed_runtime_path(self):
        approved_ops._trust_record_path(self.root).unlink()
        manifest_path = self.root / "chain" / "operator-approval.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["engineDirectory"] = r"\\untrusted-runtime.invalid\share\engine"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with mock.patch.object(approved_ops, "_runtime", side_effect=AssertionError("Untrusted runtime path was accessed")) as runtime:
            self.assertFalse(approved_ops.inspect_source(self.root)["approved"])
            runtime.assert_not_called()

    def test_copied_agent_and_carried_approval_record_require_fresh_local_approval(self):
        clone = self.root.parent / (self.root.name + "-clone")
        try:
            shutil.copytree(self.root, clone)
            # Even carrying the local anchor inside the clone is not authority.
            shutil.copy2(approved_ops._trust_record_path(self.root), clone / "copied-local-approval.json")
            self.assertFalse(approved_ops.inspect_source(clone)["approved"])
        finally:
            self.assertEqual(clone.parent.resolve(), self.root.parent.resolve())
            if clone.exists():
                shutil.rmtree(clone)

    def test_changed_local_record_fails_closed_and_revocation_removes_anchor(self):
        record = approved_ops._trust_record_path(self.root)
        original = record.read_bytes()
        value = json.loads(original)
        value["manifestSha256"] = "0" * 64
        record.write_text(json.dumps(value), encoding="utf-8")
        self.assertFalse(approved_ops.inspect_source(self.root)["approved"])
        record.write_bytes(original)
        self.assertTrue(approved_ops.inspect_source(self.root)["approved"])
        approved_ops.revoke_source(self.root, confirmed=True)
        self.assertFalse(record.exists())
        self.assertFalse(approved_ops.inspect_source(self.root)["approved"])

    def test_trust_location_inside_agent_is_rejected_before_new_approval_receipt(self):
        before = (self.root / "chain" / "rings.jsonl").read_bytes()
        with mock.patch.object(approved_ops, "TRUST_ROOT", self.root / "local-approvals"):
            with self.assertRaisesRegex(ValueError, "outside"):
                approved_ops.approve_source(self.root, hashlib.sha256(self.source).hexdigest(), confirmed=True)
        self.assertEqual((self.root / "chain" / "rings.jsonl").read_bytes(), before)

    def test_linked_local_approval_records_are_rejected(self):
        record = approved_ops._trust_record_path(self.root)
        real = self.trust / "original-approval.json"
        record.replace(real)
        try:
            record.symlink_to(real)
        except OSError:
            real.replace(record)
            self.skipTest("Creating local symbolic links is unavailable on this host.")
        self.assertFalse(approved_ops.inspect_source(self.root)["approved"])


if __name__ == "__main__":
    unittest.main()
