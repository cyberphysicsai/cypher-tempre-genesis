import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1]
ENGINE = APP / "engine" / "proof-of-interaction"
sys.path.insert(0, str(APP))
sys.path.insert(0, str(ENGINE))
inert = types.ModuleType("active_ops"); inert.OPS = {}
sys.modules.setdefault("active_ops", inert)
import portable_faculties as portable
from timechain import Timechain, atomic_write_json
import epochs
import modality_ops


class PortableFacultyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ct-portable-")
        self.base = Path(self.temp.name)
        self.donor = self.new_agent("donor")
        self.target = self.new_agent("recipient")
        self.install_fixture()

    def tearDown(self):
        self.temp.cleanup()

    def new_agent(self, name):
        root = self.base / name
        (root / "registry").mkdir(parents=True)
        for file in ("modalities.json", "senses.json"):
            shutil.copyfile(ENGINE / "registry" / file, root / "registry" / file)
        Timechain(root).genesis(name, covenant=list(portable.FRUITAGES))
        return root

    def install_fixture(self):
        ticket = epochs.begin_mutation(self.donor)
        spec = {"primitive": "compose", "of": ["numbers", "density"]}
        grown = {"registry": "grown", "modalities": [
            {"id": 900, "name": "Resonator Calibration Reasoning", "function": "Reason about resonator calibration measurements with explicit uncertainty.", "category": "knowledge", "seed_terms": ["resonator", "calibration"], "orientation": "environment-facing", "effect": {"type": "op", "spec": spec}, "origin": "emergent E1", "pinned": True},
            {"id": 901, "name": "Evidence Boundary Framing", "function": "State the boundary between supplied observations and inferences.", "category": "knowledge", "seed_terms": ["observations"], "effect": {"type": "frame", "text": "Separate observations from inferences."}, "origin": "designed"}],
            "senses": [{"id": 900, "name": "Salinity Gradient Sensing", "function": "Detect salinity gradients and missing calibration.", "category": "structural", "seed_terms": ["salinity"], "effect": {"type": "hint", "bias": "model"}, "status": "dormant", "dormant_fires": 3, "wake_hits": 1, "dormant_since": "2026-10-01T00:00:00Z", "origin": "emergent E2"}]}
        emergent = {"registry": "emergent", "faculties": [
            {"eid": "E1", "kind": "modality", "name": grown["modalities"][0]["name"], "function": grown["modalities"][0]["function"], "category": "knowledge", "seed_terms": ["resonator", "calibration"], "status": "promoted", "promoted_to_id": 900, "recurrence": 7, "born_ring": "a" * 64, "parents": ["E0"], "history": [{"context": "synthetic calibration gap", "dissonance": 190}]},
            {"eid": "E3", "kind": "sense", "name": "Authored Resonance Sensor", "function": "Propose a resonance detector for separate human review.", "category": "structural", "seed_terms": ["resonance"], "status": "emergent", "promoted_to_id": None, "recurrence": 1, "op_code": "def op(text, context=''):\n    return {'length': len(text)}\n"}]}
        atomic_write_json(self.donor / "registry/grown.json", grown)
        atomic_write_json(self.donor / "registry/emergent.json", emergent)
        atomic_write_json(self.donor / "registry/grown_ops.json", {"registry": "grown_ops", "ops": {grown["modalities"][0]["name"]: spec}})
        epochs.commit_mutation(self.donor, ticket, "synthetic portability fixture")
        atomic_write_json(self.donor / "registry/labeler.json", {"labeler_version": "fixture-1", "status": "active", "base_fingerprint": "hashing:256:v1", "labels": {"modality:900": {"name": grown["modalities"][0]["name"], "bias": 0.25, "w": {"2": 1.1, "8": -0.2}}}})

    def pack(self, keys=None):
        return portable.export_pack(self.donor, keys or ["modality:900", "modality:901", "sense:900", "emergent:E3"])

    def reviewed(self, preview):
        return {"planHash": preview["planHash"], "expectedHead": preview["expectedHead"], "reviewedAt": datetime.now(timezone.utc).isoformat(), "scores": {k: 235 for k in portable.DIMENSIONS}, "assessment": {"approved": True, "fruitages": {k: 235 for k in portable.FRUITAGES}, "rationale": "Synthetic test review: this exact local plan adds declared capabilities while retaining history and keeping authored source inert."}}

    def apply(self, pack=None, target=None):
        target = target or self.target
        pack = pack or self.pack()
        p = portable.preview_import(target, pack)
        return portable.import_pack(target, pack, p["expectedHead"], self.reviewed(p), p["planHash"])

    def test_lossless_safe_ops_frames_dormancy_lifecycle_and_inactive_learning(self):
        pack = self.pack()
        source_bytes = (self.donor / "chain/rings.jsonl").read_bytes()
        prefix = (self.target / "chain/rings.jsonl").read_bytes()
        preview = portable.preview_import(self.target, pack)
        self.assertEqual((self.target / "chain/rings.jsonl").read_bytes(), prefix)
        self.assertEqual(preview["report"]["portability"]["counts"], {"supported": 3, "frame-only": 0, "quarantined": 1, "unsupported": 0})
        self.assertIn("Separate observations", json.dumps(preview["plan"]))
        result = self.apply(pack)
        self.assertEqual(len(result["imported"]), 4)
        self.assertTrue((self.target / "chain/rings.jsonl").read_bytes().startswith(prefix))
        self.assertEqual((self.donor / "chain/rings.jsonl").read_bytes(), source_bytes)
        self.assertTrue(Timechain(self.target).verify()[0])
        self.assertTrue(epochs.check_epoch(self.target)[0])
        grown = json.loads((self.target / "registry/grown.json").read_text())
        self.assertEqual(grown["modalities"][0]["seed_terms"], ["resonator", "calibration"])
        self.assertEqual(grown["modalities"][1]["effect"]["text"], "Separate observations from inferences.")
        self.assertEqual(grown["senses"][0]["status"], "dormant")
        self.assertEqual(grown["senses"][0]["wake_hits"], 1)
        a = modality_ops.load_grown_ops(self.donor)["Resonator Calibration Reasoning"]("resonator 14 measured units")
        b = modality_ops.load_grown_ops(self.target)["Resonator Calibration Reasoning"]("resonator 14 measured units")
        self.assertEqual(a, b)
        self.assertFalse((self.target / "registry/labeler.json").exists())
        self.assertFalse((self.target / "active_ops.py").exists())
        state = portable.verified_portability_state(self.target)
        key = result["imported"][0]["key"]
        transported = state["entries"][key][0]["entry"]
        self.assertEqual(transported, pack["interaction_portability"]["entries"][0])
        self.assertEqual(transported["learnedState"]["extractorHead"]["w"], {"2": 1.1, "8": -0.2})
        reexport = portable.export_pack(self.target, [x["key"] for x in result["imported"]])
        self.assertEqual(reexport["interaction_portability"]["entries"][0]["learnedState"]["extractorHead"], transported["learnedState"]["extractorHead"])

    def test_native_format_hash_accepts_projection_but_complete_hash_authenticates_extension(self):
        import faculties
        pack = self.pack()
        self.assertEqual(faculties.pack_hash(pack), pack["pack_sha256"])
        pack["interaction_portability"]["entries"][0]["grownOp"]["of"].append("entities")
        self.assertEqual(faculties.pack_hash(pack), pack["pack_sha256"])
        with self.assertRaisesRegex(portable.PortabilityError, "Complete portable"):
            portable.validate_pack(pack)

    def test_exact_reimport_no_write_and_name_collision_no_overwrite(self):
        pack = self.pack()
        self.apply(pack)
        before = (self.target / "chain/rings.jsonl").read_bytes()
        again = self.apply(pack)
        self.assertEqual(again["imported"], [])
        self.assertEqual((self.target / "chain/rings.jsonl").read_bytes(), before)
        other = copy.deepcopy(pack); other["version"] = "different"
        other["pack_sha256"] = portable.native_hash(other); other["portable_sha256"] = portable.portable_hash(other)
        with self.assertRaises(portable.PortabilityError) as caught:
            portable.preview_import(self.target, other)
        self.assertEqual(caught.exception.code, "PACK_COLLISION")

    def test_fresh_bound_review_and_stale_head_required_before_any_write(self):
        pack = self.pack(); preview = portable.preview_import(self.target, pack)
        before = (self.target / "chain/rings.jsonl").read_bytes()
        review = self.reviewed(preview); review["assessment"]["fruitages"]["kindness"] = 12
        with self.assertRaises(portable.PortabilityError) as caught:
            portable.import_pack(self.target, pack, preview["expectedHead"], review, preview["planHash"])
        self.assertEqual(caught.exception.code, "COVENANT_REJECTED")
        self.assertEqual((self.target / "chain/rings.jsonl").read_bytes(), before)
        review = self.reviewed(preview); review["reviewedAt"] = (datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
        with self.assertRaises(portable.PortabilityError) as caught:
            portable.import_pack(self.target, pack, preview["expectedHead"], review, preview["planHash"])
        self.assertEqual(caught.exception.code, "REVIEW_EXPIRED")
        Timechain(self.target).seal("note", {"summary": "Independent synthetic append"})
        with self.assertRaises(portable.PortabilityError) as caught:
            portable.import_pack(self.target, pack, preview["expectedHead"], self.reviewed(preview), preview["planHash"])
        self.assertEqual(caught.exception.code, "STALE_HEAD")

    def test_unknown_operator_retained_quarantined_not_registered(self):
        pack = self.pack(["modality:900"])
        entry = pack["interaction_portability"]["entries"][0]
        entry["grownOp"] = {"primitive": "arbitrary", "code": "raise RuntimeError('never run')"}
        pack["portable_sha256"] = portable.portable_hash(pack)
        result = self.apply(pack)
        self.assertEqual(result["report"]["portability"]["counts"]["unsupported"], 1)
        self.assertNotIn(entry["name"], modality_ops.load_grown_ops(self.target))
        grown = json.loads((self.target / "registry/grown.json").read_text())
        self.assertEqual(grown["modalities"][0]["status"], "dormant")
        self.assertIn("portable_quarantine", grown["modalities"][0])

    def test_partial_write_failure_stays_locked_with_exact_backups(self):
        baseline = b'{"registry": "grown", "modalities": [], "senses": []}\r\n'
        ticket = epochs.begin_mutation(self.target)
        (self.target / "registry/grown.json").write_bytes(baseline)
        epochs.commit_mutation(self.target, ticket, "existing recipient baseline")
        pack = self.pack(); preview = portable.preview_import(self.target, pack)
        original = portable._write_json
        def fail(path, value):
            if Path(path) == self.target / "registry/grown_ops.json":
                raise OSError("simulated write failure")
            return original(path, value)
        with patch.object(portable, "_write_json", side_effect=fail):
            with self.assertRaises(portable.PortabilityError) as caught:
                portable.import_pack(self.target, pack, preview["expectedHead"], self.reviewed(preview), preview["planHash"])
        self.assertEqual(caught.exception.code, "PORTABILITY_INCOMPLETE")
        status = portable.recovery_status(self.target)
        self.assertTrue(status["pending"]); self.assertTrue(status["locked"])
        self.assertEqual(status["journal"]["stage"], "needs-review")
        meta = status["journal"]["files"]["registry/grown.json"]
        backup = self.target / "chain/portable-imports" / status["journal"]["transaction"] / meta["backup"]
        self.assertEqual(backup.read_bytes(), baseline)
        self.assertEqual(meta["before"], hashlib.sha256(baseline).hexdigest())
        with self.assertRaises(portable.PortabilityError) as caught:
            portable.preview_import(self.target, pack)
        self.assertEqual(caught.exception.code, "PORTABILITY_INCOMPLETE")
        with self.assertRaises(RuntimeError):
            Timechain(self.target).seal("turn", {"summary": "must not seal after incomplete import"})

    def test_sidecar_tampering_rejected_by_companion(self):
        self.apply()
        side = self.target / portable.SIDECAR
        content = json.loads(side.read_text()); content["imports"][0]["donor"] = {"forged": True}
        side.write_text(json.dumps(content))
        with self.assertRaises(portable.PortabilityError) as caught:
            portable.verified_portability_state(self.target)
        self.assertEqual(caught.exception.code, "PORTABILITY_TAMPERED")

    def test_deleted_authenticated_sidecar_is_not_treated_as_fresh(self):
        self.apply()
        (self.target / portable.SIDECAR).unlink()
        with self.assertRaises(portable.PortabilityError) as caught:
            portable.verified_portability_state(self.target)
        self.assertEqual(caught.exception.code, "PORTABILITY_TAMPERED")

    def test_materialization_preserves_exact_module_bytes_and_requires_separate_approval(self):
        import approved_ops
        sentinel = self.base / "materialization-executed.txt"
        source = ("from pathlib import Path\r\nPath(" + repr(str(sentinel)) + ").write_text('executed')\r\nOPS={}\r\n").encode()
        (self.donor / "active_ops.py").write_bytes(source)
        pack = self.pack()
        self.assertEqual(pack["interaction_portability"]["artifacts"][0]["sha256"], hashlib.sha256(source).hexdigest())
        imported = self.apply(pack)
        reexport = portable.export_pack(self.target, [x["key"] for x in imported["imported"]])
        self.assertEqual(reexport["interaction_portability"]["artifacts"][0]["text"].encode(), source)
        native_only = portable.export_pack(self.target, [imported["imported"][0]["key"]])
        self.assertEqual(native_only["interaction_portability"]["artifacts"], [])
        digest = hashlib.sha256(source).hexdigest()
        with self.assertRaises(ValueError):
            approved_ops.materialize_source(self.target, digest)
        with self.assertRaises(ValueError):
            approved_ops.materialize_source(self.target, "0" * 64, confirmed=True)
        receipt = approved_ops.materialize_source(self.target, digest, confirmed=True)
        self.assertTrue(receipt["nativeSkillMayAutoload"])
        self.assertFalse(receipt["approved"])
        self.assertEqual((self.target / "active_ops.py").read_bytes(), source)
        self.assertFalse(sentinel.exists())
        self.assertFalse((self.target / "chain/operator-approval.json").exists())
        self.assertTrue(Timechain(self.target).verify()[0])
        with self.assertRaises(ValueError):
            approved_ops.materialize_source(self.target, digest, confirmed=True)

    def test_cli_export_and_preview_never_execute_authored_source(self):
        sentinel = self.base / "executed.txt"
        source = "from pathlib import Path\nPath(" + repr(str(sentinel)) + ").write_text('bad')\nOPS={}\n"
        (self.donor / "active_ops.py").write_text(source)
        native_only = self.pack(["modality:900", "modality:901", "sense:900"])
        self.assertEqual(native_only["interaction_portability"]["artifacts"], [])
        output = self.base / "pack.json"
        result = subprocess.run([sys.executable, str(APP / "skill_interop.py"), "export", "--engine", str(ENGINE), "--root", str(self.donor), "--keys", "emergent:E3", "--out", str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        pack = json.loads(output.read_text())
        self.assertEqual(pack["interaction_portability"]["artifacts"][0]["text"].encode(), (self.donor / "active_ops.py").read_bytes())
        self.assertFalse(sentinel.exists())
        result = subprocess.run([sys.executable, str(APP / "skill_interop.py"), "--engine", str(ENGINE), "--root", str(self.target), "preview", "--pack", str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(sentinel.exists())

    def test_companion_import_stubs_native_installation_authored_module(self):
        native_copy = self.base / "trusted-engine"
        shutil.copytree(ENGINE, native_copy, ignore=shutil.ignore_patterns("__pycache__"))
        sentinel = self.base / "native-import-side-effect.txt"
        (native_copy / "active_ops.py").write_text("from pathlib import Path\nPath(" + repr(str(sentinel)) + ").write_text('executed')\nOPS={}\n")
        pack = self.pack(["modality:900"])
        preview = portable.preview_import(self.target, pack)
        pack_path = self.base / "full-pack.json"; pack_path.write_text(json.dumps(pack))
        review_path = self.base / "review.json"; review_path.write_text(json.dumps(self.reviewed(preview)))
        result = subprocess.run([sys.executable, str(APP / "skill_interop.py"), "--engine", str(native_copy), "--root", str(self.target), "import", "--pack", str(pack_path), "--review", str(review_path), "--expected-head", preview["expectedHead"], "--plan-hash", preview["planHash"], "--confirm"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(sentinel.exists())

    def test_process_exit_mid_write_leaves_durable_native_lockdown(self):
        pack = self.pack(["modality:900"])
        pack_path = self.base / "crash-pack.json"; pack_path.write_text(json.dumps(pack))
        script = """
import sys,json,os,types
from pathlib import Path
from datetime import datetime,timezone
sys.path.insert(0,sys.argv[1]);sys.path.insert(0,sys.argv[2])
inert=types.ModuleType('active_ops');inert.OPS={};sys.modules['active_ops']=inert
import portable_faculties as p
root=Path(sys.argv[3]);pack=json.loads(Path(sys.argv[4]).read_text())
preview=p.preview_import(root,pack)
review={'planHash':preview['planHash'],'expectedHead':preview['expectedHead'],'reviewedAt':datetime.now(timezone.utc).isoformat(),'scores':{k:235 for k in p.DIMENSIONS},'assessment':{'approved':True,'fruitages':{k:235 for k in p.FRUITAGES},'rationale':'Synthetic crash fixture approves this exact local capability plan.'}}
write=p._write_json
def crash(path,data):
    write(path,data)
    if Path(path)==root/'registry/grown.json':os._exit(37)
p._write_json=crash
p.import_pack(root,pack,preview['expectedHead'],review,preview['planHash'])
"""
        result = subprocess.run([sys.executable, "-c", script, str(APP), str(ENGINE), str(self.target), str(pack_path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 37, result.stdout + result.stderr)
        status = portable.recovery_status(self.target)
        self.assertTrue(status["pending"]); self.assertTrue(status["locked"])
        self.assertEqual(status["journal"]["stage"], "prepared")
        before = (self.target / "chain/rings.jsonl").read_bytes()
        with self.assertRaises(portable.PortabilityError):
            portable.preview_import(self.target, pack)
        with self.assertRaises(RuntimeError):
            Timechain(self.target).seal("turn", {"summary": "must stay locked after process exit"})
        self.assertEqual((self.target / "chain/rings.jsonl").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
