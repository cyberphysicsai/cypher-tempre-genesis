"""Contract and integrity tests using disposable real canonical Timechains."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

PRODUCT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("engine_bridge", PRODUCT / "engine_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class EngineBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "agent"
        self.call("init", name="Test Agent")

    def tearDown(self):
        self.temp.cleanup()

    def call(self, op, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return bridge.dispatch({"op": op, "root": str(self.root), **kwargs})

    def head(self):
        return self.call("verify")["head"]["hash"]

    def exchange(self, **kwargs):
        return {"input": "Help me reason patiently about this question.",
                "output": "We can consider the question patiently and clearly, and acknowledge uncertainty where information is missing.",
                "scores": {d: 230 for d in bridge.DIMENSIONS},
                "assessment": {"approved": True, "fruitages": {k: 235 for k in bridge.FRUITAGES},
                               "rationale": "The response is honest, patient, kind, and promotes the user's understanding."},
                **kwargs}

    def commit(self, **kwargs):
        return self.call("commit", expectedHead=self.head(), growth=False, **self.exchange(**kwargs))

    def assert_code(self, code, function):
        with self.assertRaises(bridge.BridgeError) as raised:
            function()
        self.assertEqual(raised.exception.code, code)

    def test_fresh_genesis_and_existing_history_are_preserved(self):
        state = self.call("inspect")
        self.assertEqual(state["height"], 1)
        self.assertEqual(state["genesis"]["covenant"], list(bridge.FRUITAGES))
        path = self.root / "chain" / "rings.jsonl"
        before = path.read_bytes()
        self.assert_code("ROOT_NOT_EMPTY", lambda: self.call("init", name="Overwrite"))
        result = self.commit()
        self.assertTrue(result["sealed"])
        self.assertTrue(path.read_bytes().startswith(before))
        ring = json.loads(path.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(ring["payload"]["input"], self.exchange()["input"])
        self.assertEqual(ring["payload"]["output"], self.exchange()["output"])
        self.assertTrue(self.call("verify")["verified"])

    def test_original_skill_chain_and_adjective_covenant_remain_unchanged(self):
        legacy = Path(self.temp.name) / "original-agent"
        (legacy / "registry").mkdir(parents=True)
        import shutil
        for name in ("senses.json", "modalities.json"):
            shutil.copyfile(bridge.ENGINE / "registry" / name, legacy / "registry" / name)
        tc = bridge.Timechain(legacy)
        tc.genesis("Original Agent")
        tc.seal("experience", {"summary": "A prior agent session."}, poi={d: 230 for d in bridge.DIMENSIONS})
        before = tc.rings_path.read_bytes()
        self.root = legacy
        state = self.call("inspect")
        self.assertIn("loving", state["genesis"]["covenant"])
        self.call("prepare", input="Please recall the prior agent session.")
        self.assertEqual(tc.rings_path.read_bytes(), before)
        self.commit()
        self.assertTrue(tc.rings_path.read_bytes().startswith(before))
        self.assertTrue(tc.verify()[0])

    def test_concurrent_processes_cannot_both_append_to_same_expected_head(self):
        request = {"op": "commit", "root": str(self.root), "expectedHead": self.head(),
                   "growth": False, **self.exchange()}
        def worker():
            process = subprocess.run([sys.executable, str(PRODUCT / "engine_bridge.py")],
                       input=json.dumps(request).encode("utf-8"), stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, timeout=30, check=True)
            return json.loads(process.stdout)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: worker(), range(2)))
        self.assertEqual(sum(r["ok"] for r in results), 1)
        rejected = next(r for r in results if not r["ok"])
        self.assertEqual(rejected["error"]["code"], "STALE_HEAD")
        self.assertEqual(self.call("inspect")["height"], 2)

    def test_missing_invalid_and_low_scores_fail_closed(self):
        original = (self.root / "chain" / "rings.jsonl").read_bytes()
        for bad in (None, {}, {"approved": False}, {"approved": True, "fruitages": {}}):
            with self.subTest(assessment=bad):
                with self.assertRaises(bridge.BridgeError):
                    self.commit(assessment=bad)
        for fruit in bridge.FRUITAGES:
            assessment = self.exchange()["assessment"]
            assessment["fruitages"][fruit] = 179
            self.assert_code("COVENANT_REJECTED", lambda: self.commit(assessment=assessment))
        scores = self.exchange()["scores"]
        scores["covenant"] = 1
        self.assert_code("COVENANT_REJECTED", lambda: self.commit(scores=scores))
        scores = self.exchange()["scores"]
        scores["coherence"] = True
        self.assert_code("REVIEW_INVALID", lambda: self.commit(scores=scores))
        self.assertEqual((self.root / "chain" / "rings.jsonl").read_bytes(), original)

    def test_native_poi_consistency_rejects_even_with_high_fruitages(self):
        scores = self.exchange()["scores"]
        scores["consistency"] = 1
        self.assert_code("POI_REJECTED", lambda: self.commit(scores=scores))
        self.assertEqual(self.call("inspect")["height"], 1)

    def test_evaluate_is_not_a_seal_and_batch_keeps_all_pairs(self):
        first = self.exchange()
        second = self.exchange(input="What should we do next?", output="We could compare the available options with care before choosing a next step.")
        evaluation = self.call("evaluate", expectedHead=self.head(), **first)
        self.assertTrue(evaluation["accepted"])
        self.assertFalse(evaluation["sealed"])
        self.assertEqual(self.call("inspect")["height"], 1)
        result = self.call("commit", expectedHead=self.head(), exchanges=[first, second], growth=False)
        self.assertEqual(result["exchanges"], 2)
        self.assertEqual(self.call("inspect")["height"], 2)
        history = self.call("inspect")["history"]
        self.assertEqual([h["input"] for h in history], [first["input"], second["input"]])
        self.assertEqual(history[0]["hash"], history[1]["hash"])

    def test_stale_head_fails_without_append(self):
        old = self.head()
        self.commit()
        height = self.call("inspect")["height"]
        self.assert_code("STALE_HEAD", lambda: self.call("commit", expectedHead=old, growth=False, **self.exchange()))
        self.assertEqual(self.call("inspect")["height"], height)

    def test_lost_commit_receipt_is_idempotent_and_collision_is_rejected(self):
        ident = str(uuid.uuid4())
        old_head = self.head()
        exchange = self.exchange()
        original = self.call("commit", expectedHead=old_head, commitId=ident,
                             exchanges=[exchange], growth=False)
        replay = self.call("commit", expectedHead=old_head, commitId=ident,
                           exchanges=[exchange], growth=False)
        self.assertTrue(replay["replayedCommit"])
        self.assertEqual(replay["ring"], original["ring"])
        self.assertEqual(self.call("inspect")["height"], 2)
        changed = self.exchange(output="A different response.")
        self.assert_code("COMMIT_ID_CONFLICT", lambda: self.call("commit", expectedHead=self.head(),
                         commitId=ident, exchanges=[changed], growth=False))

    def test_equipped_faculties_drive_context_and_ops(self):
        before = (self.root / "chain" / "rings.jsonl").read_bytes()
        faculties = self.call("inspect")["faculties"]
        one = faculties[0]
        prepared = self.call("prepare", input="How do we identify the most important concepts?", loadout=[one["key"]])
        self.assertEqual([f["key"] for f in prepared["loadout"]], [one["key"]])
        self.assertEqual(prepared["labels"]["equipped"], [one["key"]])
        self.assertTrue(set(prepared["computed"]) <= {one["name"]})
        self.assertEqual((self.root / "chain" / "rings.jsonl").read_bytes(), before)
        self.assert_code("INVALID_LOADOUT", lambda: self.call("prepare", input="Test", loadout=["sense:999999"]))

    def test_recent_dialogue_survives_semantic_recall_toggle(self):
        self.commit()
        prepared = self.call("prepare", input="What about that?", recall=False, loadout=[])
        self.assertEqual(len(prepared["recentHistory"]), 1)
        self.assertEqual(prepared["memories"], [])
        self.assertIn(self.exchange()["output"], prepared["context"])

    def test_recalled_memories_fetch_evidence_beyond_preview_excerpt(self):
        output = ("We can patiently consider the question while acknowledging uncertainty. " * 7
                  + "The distinguishing note is indigo-lattice.")
        self.commit(output=output)
        prepared = self.call("prepare", input=self.exchange()["input"])
        self.assertTrue(prepared["memories"])
        self.assertIn("indigo-lattice", prepared["memories"][0]["text"])

    def test_post_seal_guard_error_never_returns_accepted(self):
        ident = str(uuid.uuid4())
        original_head = self.head()
        exchanges = [self.exchange()]
        with patch.object(bridge.immune, "guard_turn", return_value={"action": "error", "error": "unknown"}):
            self.assert_code("POST_SEAL_GUARD", lambda: self.call("commit", expectedHead=original_head,
                             commitId=ident, exchanges=exchanges, growth=False))
            self.assert_code("POST_SEAL_GUARD", lambda: self.call("commit", expectedHead=original_head,
                             commitId=ident, exchanges=exchanges, growth=False))
        self.assertEqual(self.call("inspect")["height"], 2)
        self.assertEqual(self.call("inspect")["history"], [])
        prepared = self.call("prepare", input=self.exchange()["input"])
        self.assertEqual(prepared["recentHistory"], [])
        self.assertEqual(prepared["memories"], [])
        recovered = self.call("commit", expectedHead=original_head, commitId=ident,
                              exchanges=exchanges, growth=False)
        self.assertTrue(recovered["replayedCommit"])
        self.assertEqual(len(self.call("inspect")["history"]), 1)

    def test_growth_adds_real_faculties_with_matching_epochs(self):
        before = len(self.call("inspect")["faculties"])
        result = self.call("commit", expectedHead=self.head(), growth=True, **self.exchange())
        state = self.call("inspect")
        self.assertTrue(result["sealed"])
        self.assertTrue(state["verified"])
        self.assertGreater(len(state["faculties"]), before)
        self.assertTrue(any(f["source"] == "grown" for f in state["faculties"]))
        self.assertEqual(len(state["history"]), 1)

    def test_cli_growth_emits_one_valid_json_receipt(self):
        request = {"op": "commit", "root": str(self.root), "expectedHead": self.head(),
                   "growth": True, **self.exchange()}
        process = subprocess.run([sys.executable, str(PRODUCT / "engine_bridge.py")],
                  input=json.dumps(request).encode("utf-8"), stdout=subprocess.PIPE,
                  stderr=subprocess.PIPE, timeout=30, check=True)
        result = json.loads(process.stdout)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["sealed"])
        self.assertTrue(result["growth"])
        self.assertTrue(self.call("verify")["verified"])

    def test_batched_loadout_changes_keep_per_exchange_faculty_receipts(self):
        first_key, second_key = [f["key"] for f in self.call("inspect")["faculties"][:2]]
        first = self.exchange(loadout=[first_key])
        second = self.exchange(loadout=[second_key])
        self.call("commit", expectedHead=self.head(), exchanges=[first, second],
                  loadout=[first_key, second_key], growth=False)
        payload = bridge.Timechain(self.root)._tail_ring()["payload"]
        self.assertEqual(payload["loadout"], [first_key, second_key])
        self.assertEqual(payload["exchanges"][0]["labels"]["equipped"], [first_key])
        self.assertEqual(payload["exchanges"][1]["labels"]["equipped"], [second_key])

    def test_perspective_notes_use_native_collapse_and_remain_auditable(self):
        perspectives = [{"name": f"Lens {n}", "summary": f"Consider the question through lens {n} while acknowledging uncertainty.",
                         "scores": {d: 200 + n for d in bridge.DIMENSIONS}} for n in range(1, 22)]
        self.commit(perspectives=perspectives)
        ring = bridge.Timechain(self.root)._tail_ring()
        collapse = ring["payload"]["exchanges"][0]["chronosynaptic"]
        self.assertEqual(collapse["collapsed_from"], 21)
        self.assertEqual(collapse["chosen_perspective"]["name"], "Lens 21")
        self.assertEqual(len(collapse["rejected_perspectives"]), 20)
        self.assert_code("INVALID_PERSPECTIVES", lambda: self.commit(perspectives=perspectives + perspectives[:1]))

    def test_continuum_respects_utf8_bytes_and_source_is_data(self):
        source = "Physics λ and harmony 🌱\n" * 19
        ex = self.exchange()
        out = self.call("ingest", expectedHead=self.head(), text=source, name="notes.txt", targetBytes=31,
                        scores=ex["scores"], assessment=ex["assessment"])
        self.assertTrue(out["sealed"])
        rings = [r for r in bridge.Timechain(self.root).iter_rings() if r["ring_type"] == "continuum"]
        chunks = [r["payload"]["data"]["content"] for r in rings]
        self.assertEqual("".join(chunks), source)
        self.assertTrue(all(len(x.encode("utf-8")) <= 31 for x in chunks))
        self.assertEqual(out["sourceHash"], hashlib.sha256(source.encode()).hexdigest())
        self.assertTrue(self.call("verify")["verified"])

    def test_tampering_and_paused_chain_fail_closed(self):
        (self.root / "chain" / "PAUSED").write_text("paused", encoding="utf-8")
        self.assert_code("CHAIN_PAUSED", lambda: self.call("prepare", input="Hello"))
        (self.root / "chain" / "PAUSED").unlink()
        path = self.root / "registry" / "senses.json"
        bad = json.loads(path.read_text(encoding="utf-8"))
        bad["senses"][0]["name"] = "tampered"
        path.write_text(json.dumps(bad), encoding="utf-8")
        # A newly initialized native chain has no epoch, so the genesis hash of
        # attached registries must also be checked by the wrapper.
        self.assert_code("INTEGRITY_FAILED", lambda: self.call("prepare", input="Hello"))

    def pack(self, faculties=None):
        import faculties as native
        pack = {"pack_format": 1, "name": "Quantum Fieldcraft", "version": "1.0.0", "domain": "Physics",
                "author": "Example Donor", "created_at": "2026-10-28T00:00:00Z",
                "donor": {"genesis_name": "Example Donor", "chain_head_index": 10, "chain_head_hash": "a" * 64},
                "faculties": faculties or [
                    {"kind": "sense", "name": "Interferometric Phase Sensing",
                     "function": "Detect interferometric qubit Hamiltonian phase decoherence, solitonic resonances, and entanglement anomalies in quantum circuit measurements.",
                     "category": "physics", "seed_terms": ["interferometric", "qubit", "Hamiltonian"],
                     "status": "promoted", "provenance": {"origin": "designed", "donor_id": 120}},
                    {"kind": "modality", "name": "Mycorrhizal Symbiosis Reasoning",
                     "function": "Compare mycorrhizal hyphae, rhizosphere symbiosis, spore germination, photosynthate transfer, ectomycorrhizal phosphorus uptake, and fungal nitrogen pathways.",
                     "category": "ecology", "seed_terms": ["mycorrhizal", "hyphae", "rhizosphere"],
                     "status": "promoted", "provenance": {"origin": "designed", "donor_id": 130}},
                ]}
        pack["pack_sha256"] = native.pack_hash(pack)
        return pack

    def import_pack(self, pack=None, **kwargs):
        ex = self.exchange()
        request = {"pack": pack or self.pack(), "expectedHead": self.head(),
                   "assessment": ex["assessment"], "scores": ex["scores"], **kwargs}
        return self.call("pack_import", **request)

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}

    def test_pack_preview_is_byte_exact_read_only(self):
        before = self.snapshot()
        preview = self.call("pack_preview", pack=self.pack())
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(preview["donorVerified"])
        self.assertEqual(len(preview["report"]["imported"]), 2)
        self.assertIn("Interferometric Phase Sensing", preview["action"]["output"])

    def test_pack_import_native_provenance_equipment_and_roundtrip(self):
        pack = self.pack()
        before = (self.root / "chain" / "rings.jsonl").read_bytes()
        result = self.import_pack(pack)
        self.assertTrue(result["accepted"])
        self.assertEqual(len(result["imported"]), 2)
        self.assertTrue((self.root / "chain" / "rings.jsonl").read_bytes().startswith(before))
        selected = result["imported"][0]["key"]
        state = self.call("inspect")
        faculty = next(f for f in state["faculties"] if f["key"] == selected)
        self.assertEqual(faculty["source"], "imported")
        self.assertTrue(faculty["equippable"])
        self.assertTrue(faculty["exportable"])
        self.assertFalse(faculty["provenance"]["donorVerified"])
        self.assertEqual(faculty["provenance"]["pack_sha256"], pack["pack_sha256"])
        prepared = self.call("prepare", input="Interpret an interferometric quantum circuit.", loadout=[selected])
        self.assertIn(pack["faculties"][0]["function"], prepared["context"])
        before_export = self.snapshot()
        exported = self.call("pack_export", keys=[selected], name="Shared Phase Lens")
        self.assertEqual(self.snapshot(), before_export)
        self.assertEqual(exported["count"], 1)
        actual = exported["pack"]["faculties"][0]
        for field in ("name", "function", "category", "seed_terms"):
            self.assertEqual(actual[field], pack["faculties"][0][field])
        import faculties as native
        self.assertEqual(native.pack_hash(exported["pack"]), exported["pack"]["pack_sha256"])
        self.assertTrue(self.call("verify")["verified"])

    def test_pack_reimport_skips_existing_and_does_not_duplicate(self):
        self.import_pack()
        before = self.snapshot()
        second = self.import_pack()
        self.assertEqual(second["imported"], [])
        self.assertIsNone(second["ring"])
        self.assertEqual(self.snapshot(), before)

    def test_pack_bad_second_entry_cannot_partially_import(self):
        pack = self.pack()
        pack["faculties"][1]["kind"] = "python"
        import faculties as native
        pack["pack_sha256"] = native.pack_hash(pack)
        before = self.snapshot()
        self.assert_code("PACK_INVALID", lambda: self.import_pack(pack))
        self.assertEqual(self.snapshot(), before)

    def test_pack_hash_bad_review_and_code_fields_are_rejected_before_writes(self):
        before = self.snapshot()
        pack = self.pack()
        pack["faculties"][0]["function"] += " altered"
        self.assert_code("PACK_HASH_MISMATCH", lambda: self.import_pack(pack))
        assessment = self.exchange()["assessment"]
        assessment["fruitages"]["love"] = 179
        self.assert_code("COVENANT_REJECTED", lambda: self.import_pack(assessment=assessment))
        pack = self.pack()
        pack["faculties"][0]["code"] = "print('never executed')"
        import faculties as native
        pack["pack_sha256"] = native.pack_hash(pack)
        self.assert_code("PACK_INVALID", lambda: self.call("pack_preview", pack=pack))
        self.assertEqual(self.snapshot(), before)

    def test_pack_existing_name_hijack_and_path_labels_reject(self):
        pack = self.pack()
        pack["faculties"][0]["name"] = self.call("inspect")["faculties"][0]["name"]
        import faculties as native
        pack["pack_sha256"] = native.pack_hash(pack)
        before = self.snapshot()
        self.assert_code("PACK_COLLISION", lambda: self.call("pack_preview", pack=pack))
        pack = self.pack()
        pack["name"] = "../../escape"
        pack["pack_sha256"] = native.pack_hash(pack)
        self.assert_code("PACK_INVALID", lambda: self.import_pack(pack))
        self.assertEqual(self.snapshot(), before)

    def test_pack_export_rejects_base_faculties_and_leaks_no_chat_history(self):
        base_key = self.call("inspect")["faculties"][0]["key"]
        self.assert_code("PACK_INVALID", lambda: self.call("pack_export", keys=[base_key]))
        imported = self.import_pack()
        self.commit(input="Keep this personal notebook phrase in this chain: tangerine-amphora.")
        out = self.call("pack_export", keys=[imported["imported"][0]["key"]])
        self.assertNotIn("tangerine-amphora", json.dumps(out["pack"]))
        self.assertEqual(set(out["pack"]["faculties"][0]["provenance"]), {"origin", "donor_id"})

    def test_pack_pre_epoch_write_failure_restores_registry_without_history_rewrite(self):
        before = (self.root / "chain" / "rings.jsonl").read_bytes()
        with patch.object(bridge.epochs, "commit_mutation", side_effect=OSError("simulated write fault")):
            self.assert_code("PACK_IMPORT_INCOMPLETE", lambda: self.import_pack())
        self.assertFalse((self.root / "registry" / "grown.json").exists())
        self.assertTrue((self.root / "chain" / "rings.jsonl").read_bytes().startswith(before))
        self.assertTrue(self.call("verify")["verified"])
        journals = list((self.root / "chain" / "faculty-imports").glob("*/transaction.json"))
        self.assertEqual(len(journals), 1)
        self.assertEqual(json.loads(journals[0].read_text())["stage"], "rolled-back")

    def test_pack_post_epoch_failure_never_rolls_back_committed_registry(self):
        before = (self.root / "chain" / "rings.jsonl").read_bytes()
        commit = bridge.epochs.commit_mutation
        def failed_ack(*args, **kwargs):
            commit(*args, **kwargs)
            raise OSError("simulated acknowledgment loss after epoch append")
        with patch.object(bridge.epochs, "commit_mutation", side_effect=failed_ack):
            self.assert_code("PACK_IMPORT_INCOMPLETE", lambda: self.import_pack())
        self.assertTrue((self.root / "chain" / "rings.jsonl").read_bytes().startswith(before))
        self.assertTrue(self.call("verify")["verified"])
        journals = list((self.root / "chain" / "faculty-imports").glob("*/transaction.json"))
        self.assertEqual(json.loads(journals[0].read_text())["stage"], "needs-review")
        self.assertEqual(len([f for f in self.call("inspect")["faculties"] if f["source"] == "imported"]), 2)

    def test_pack_export_filters_legacy_duplicate_names_by_exact_id(self):
        ticket = bridge.epochs.begin_mutation(self.root)
        grown = {"registry": "grown", "senses": [], "modalities": [
            {"id": 801, "name": "Legacy Shared Name", "function": "Selected lens definition.", "category": "knowledge", "origin": "legacy"},
            {"id": 802, "name": "Legacy Shared Name", "function": "Unselected private lens definition.", "category": "knowledge", "origin": "legacy"},
        ]}
        bridge.atomic_write_json(self.root / "registry" / "grown.json", grown)
        bridge.epochs.commit_mutation(self.root, ticket, reason="test legacy duplicate names")
        exported = self.call("pack_export", keys=["modality:801"])
        self.assertEqual(exported["count"], 1)
        self.assertEqual(exported["pack"]["faculties"][0]["function"], "Selected lens definition.")
        self.assertNotIn("Unselected private", json.dumps(exported["pack"]))

    def test_pack_import_stale_head_fails_before_registry_write(self):
        before = self.snapshot()
        self.assert_code("STALE_HEAD", lambda: self.import_pack(expectedHead="0" * 64))
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
