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

    def test_declared_evidence_enforces_aggregate_coverage(self):
        tc = bridge.Timechain(self.root)
        evidence = tc.seal("experience", {"summary": "One observation records a count of 11."},
                           poi=self.exchange()["scores"])
        (self.root / "registry" / "policy.json").write_text(
            json.dumps({"poi": {"aggregate_min_terms": 5}}), encoding="utf-8")
        exchange = self.exchange(input="Give the total count across all observations.",
                                 output="The total count is 99 across all observations.")
        before = tc.rings_path.read_bytes()
        for used in ([], [evidence["index"]]):
            with self.assertRaises(bridge.BridgeError) as rejected:
                self.call("evaluate", **exchange, usedRings=used)
            self.assertEqual(rejected.exception.code, "POI_REJECTED")
            verdict = rejected.exception.details["verdict"]
            self.assertEqual(verdict["decision"], "FORCE_UNCERTAINTY")
            self.assertTrue(any("aggregate_min_terms 5" in reason for reason in verdict["reasons"]))
        self.assertEqual(tc.rings_path.read_bytes(), before)

    def test_armed_entity_grounding_cannot_use_prompt_metadata_as_evidence(self):
        tc = bridge.Timechain(self.root)
        evidence = tc.seal("experience", {"summary": "A measurement in metres was recorded in a document."},
                           poi=self.exchange()["scores"])
        (self.root / "registry" / "policy.json").write_text(
            json.dumps({"floors": {"entity_grounding_enforce": True}}), encoding="utf-8")
        exchange = self.exchange(input="Summarize the measurement reported in the evidence.",
                                 output="The measurement was 875 metres in document.txt.")
        for used in ([], [evidence["index"]]):
            with self.assertRaises(bridge.BridgeError) as rejected:
                self.call("evaluate", **exchange, usedRings=used,
                          groundingContext='{"faculty_id":875,"source":"document.txt"}')
            verdict = rejected.exception.details["verdict"]
            self.assertEqual(verdict["decision"], "FORCE_UNCERTAINTY")
            self.assertEqual(verdict["entity_grounding"], 0)
            self.assertEqual(set(verdict["specifics_missing"]), {"875", "document.txt"})

    def test_declared_evidence_comes_from_canonical_records_and_is_sealed(self):
        tc = bridge.Timechain(self.root)
        evidence = tc.seal("experience", {"summary": "The measurement was 875 metres in document.txt."},
                           poi=self.exchange()["scores"])
        (self.root / "registry" / "policy.json").write_text(
            json.dumps({"floors": {"entity_grounding_enforce": True}}), encoding="utf-8")
        self.commit(input="Summarize the recorded measurement.",
                    output="The measurement was 875 metres in document.txt.", usedRings=[evidence["index"]])
        item = tc._tail_ring()["payload"]["exchanges"][0]
        self.assertEqual(item["usedRings"], [evidence["index"]])
        self.assertEqual(item["evidence"][0]["hash"], evidence["ring_hash"])
        self.assertEqual(item["gate"]["entity_grounding"], 255)

    def test_declared_evidence_rejects_missing_genesis_duplicate_and_unreleased_refs(self):
        evidence = bridge.Timechain(self.root).seal("turn", {"event": "web_chat_turn", "input": "hidden",
                                                   "output": "held"}, poi=self.exchange()["scores"])
        for used in ([True], [0], [999], [1, 1], [evidence["index"]], "1"):
            self.assert_code("EVIDENCE_INVALID", lambda used=used: self.call("evaluate", **self.exchange(), usedRings=used))

    def test_available_evidence_is_bounded_utf8_and_does_not_claim_use(self):
        text = "spectrometer λ indigo-lattice " * 1000
        tc = bridge.Timechain(self.root)
        evidence = tc.seal("experience", {"summary": text}, poi=self.exchange()["scores"])
        prepared = self.call("prepare", input="spectrometer indigo-lattice", loadout=[])
        offered = next(e for e in prepared["availableEvidence"] if e["index"] == evidence["index"])
        self.assertTrue(offered["truncated"])
        self.assertLessEqual(len(offered["text"].encode("utf-8")), bridge.MAX_EVIDENCE_BYTES)
        self.assertEqual(offered, bridge.declared_evidence(tc, [evidence["index"]])[0])
        self.assertNotIn("usedRings", prepared)

    def test_source_sanitization_is_readonly_and_ingestion_defensively_redacts(self):
        source = "Example configuration: password=synthetic-not-a-real-secret\n"
        tc = bridge.Timechain(self.root)
        before = tc.rings_path.read_bytes()
        safe = self.call("sanitize_source", text=source)
        self.assertEqual(safe["redactionCount"], 1)
        self.assertNotIn("synthetic-not-a-real-secret", safe["text"])
        self.assertEqual(safe["bytes"], len(safe["text"].encode("utf-8")))
        self.assertEqual(safe["sourceHash"], hashlib.sha256(safe["text"].encode("utf-8")).hexdigest())
        self.assertEqual(tc.rings_path.read_bytes(), before)
        ex = self.exchange()
        out = self.call("ingest", expectedHead=self.head(), text=source, name="synthetic.txt", targetBytes=11,
                        scores=ex["scores"], assessment=ex["assessment"])
        data = [r["payload"]["data"] for r in tc.iter_rings() if r["ring_type"] == "continuum"]
        self.assertEqual("".join(d["content"] for d in data), safe["text"])
        self.assertTrue(all(len(d["content"].encode("utf-8")) <= 11 for d in data))
        self.assertTrue(all(d["redacted"] and d["redaction_count"] == 1 for d in data))
        self.assertEqual(out["redactionCount"], 1)

    def test_ingestion_preserves_presanitized_review_metadata_and_checks_hash(self):
        safe = self.call("sanitize_source", text="password=synthetic-not-a-real-secret\n")
        ex = self.exchange()
        self.assert_code("SOURCE_CHANGED", lambda: self.call("ingest", expectedHead=self.head(),
                         **{**safe, "sourceHash": "0" * 64}, name="safe.txt", scores=ex["scores"], assessment=ex["assessment"]))
        result = self.call("ingest", expectedHead=self.head(), **safe, name="safe.txt", targetBytes=1024,
                           scores=ex["scores"], assessment=ex["assessment"])
        self.assertEqual(result["redactionCount"], 1)
        self.assertEqual(bridge.Timechain(self.root)._tail_ring()["payload"]["data"]["redaction_count"], 1)

    def test_presanitized_source_byte_boundaries_do_not_rewrite_mask_fragments(self):
        safe = self.call("sanitize_source", text="password=synthetic-not-a-real-secret\n")
        ex = self.exchange()
        tc = bridge.Timechain(self.root)
        for size in (8, 16, 17):
            start = self.call("inspect")["height"]
            counts = []
            for i, chunk in enumerate(bridge.utf8_chunks(safe["text"], size)):
                result = self.call("ingest", expectedHead=self.head(), text=chunk,
                                   sourceHash=hashlib.sha256(chunk.encode("utf-8")).hexdigest(),
                                   redactionCount=safe["redactionCount"] if i == 0 else 0,
                                   name="safe.txt", targetBytes=size,
                                   scores=ex["scores"], assessment=ex["assessment"])
                counts.append(result["redactionCount"])
            data = [r["payload"]["data"] for r in tc.iter_rings()
                    if r["index"] >= start and r["ring_type"] == "continuum"]
            self.assertEqual("".join(d["content"] for d in data), safe["text"])
            self.assertEqual(sum(counts), 1)
            self.assertTrue(all(len(d["content"].encode("utf-8")) <= size for d in data))

    def test_mask_fragment_allowance_does_not_exempt_real_or_near_match_values(self):
        ex = self.exchange()
        for source in ("password=[REDACTEX", "password=[REDACTED_SECRET]real-secret",
                       "password=[REDACTEreal-secret", "password=synthetic-not-a-real-secret"):
            self.assert_code("SOURCE_CHANGED", lambda source=source: self.call(
                "ingest", expectedHead=self.head(), text=source, name="fixture.txt",
                sourceHash=hashlib.sha256(source.encode("utf-8")).hexdigest(), targetBytes=1024,
                scores=ex["scores"], assessment=ex["assessment"]))
        # Even a valid terminal marker prefix cannot protect another raw secret.
        source = "password=synthetic-not-a-real-secret\ntoken=[REDACTE"
        self.assert_code("SOURCE_CHANGED", lambda: self.call(
            "ingest", expectedHead=self.head(), text=source, name="fixture.txt",
            sourceHash=hashlib.sha256(source.encode("utf-8")).hexdigest(), targetBytes=1024,
            scores=ex["scores"], assessment=ex["assessment"]))

    def test_ingestion_honors_explicit_equipment_even_for_relevant_dormant_faculties(self):
        import cambium
        with contextlib.redirect_stdout(io.StringIO()):
            cambium.save_grown(self.root, {"registry": "grown", "modalities": [{"id": 999,
                "name": "Photonic Lattice Tomography", "function": "Interpret photonic lattice tomography measurements.",
                "category": "Fixture", "status": "dormant", "seed_terms": ["photonic", "lattice", "tomography"],
                "effect": {"type": "frame", "text": "Inspect photonic lattice uncertainty."}}], "senses": []})
        ex = self.exchange()
        for loadout in ([], ["modality:999"]):
            self.call("ingest", expectedHead=self.head(), text="Photonic lattice tomography measurement",
                      name="photonic.txt", targetBytes=1024, loadout=loadout,
                      scores=ex["scores"], assessment=ex["assessment"])
            labels = bridge.Timechain(self.root)._tail_ring()["payload"]["labels"]
            self.assertEqual(labels["equipped"], loadout)
            if loadout:
                self.assertEqual(labels["frames"], ["Inspect photonic lattice uncertainty."])
                self.assertEqual(labels["modalities"][0]["id"], 999)
            else:
                self.assertEqual(labels["modalities"], [])
                self.assertEqual(labels["frames"], [])
                self.assertEqual(labels["computed"], {})

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


    def test_runtime_pause_resume_preserve_history_and_require_explicit_control(self):
        before = self.snapshot()
        state = self.call("runtime_status")
        self.assertTrue(state["runtime"]["supported"])
        self.assertEqual(state["runtime"]["mode"], "active")
        self.assert_code("CONFIRMATION_REQUIRED", lambda: self.call("dormancy", action="pause", expectedHead=self.head()))
        paused = self.call("dormancy", action="pause", confirmed=True, expectedHead=self.head())
        self.assertEqual(paused["runtime"]["mode"], "dormant")
        self.assert_code("CHAIN_PAUSED", lambda: self.call("prepare", input="A regular conversation."))
        self.assert_code("CHAIN_PAUSED", lambda: self.call("route", input="A regular conversation."))
        self.call("dormancy", action="resume", confirmed=True, expectedHead=self.head())
        self.assertEqual(before, self.snapshot())

    def test_learning_off_skips_telemetry_teaching_and_growth_but_seals(self):
        import cambium
        before_catalog = self.call("inspect")["faculties"]
        before = self.snapshot()
        prepared = self.call("prepare", input=self.exchange()["input"], learning=False)
        self.call("route", input=self.exchange()["input"], learning=False)
        self.call("memory", query=self.exchange()["input"], learning=False)
        self.assertFalse(prepared["runtime"]["learning"])
        self.assertEqual(before, self.snapshot())
        with patch.object(cambium, "fill_gap", side_effect=AssertionError("Growth ran while disabled")):
            self.call("commit", expectedHead=self.head(), learning=False, growth=True, **self.exchange())
        self.assertEqual(before_catalog, self.call("inspect")["faculties"])
        self.assertFalse((self.root / "chain" / "telemetry.jsonl").exists())
        self.assertEqual(self.call("inspect")["height"], 2)
        self.assert_code("LEARNING_DISABLED", lambda: self.call("teach", learning=False, **self.exchange()))

    def test_model_scored_native_tree_uses_real_depth_and_backpropagation(self):
        ex = self.exchange()
        candidates = [{"name": name, "summary": ex["output"], "scores": ex["scores"],
                       "assessment": ex["assessment"]} for name in ("Skeptic", "Builder")]
        before = self.snapshot()
        search = self.call("search", input=ex["input"], perspectives=candidates,
                           iterations=12, depth=3, learning=False)["search"]
        self.assertEqual(search["algorithm"], "native-uic-mcts")
        self.assertEqual(search["exploredDepth"], 1)
        self.assertEqual(sum(n["visits"] for n in search["nodes"]), 12)
        rollouts = [{**candidates[0], "path": ["Skeptic", "Evidence"]},
                    {**candidates[0], "path": ["Skeptic", "Evidence", "Verification"]}]
        deep = self.call("search", input=ex["input"], perspectives=candidates,
                         rollouts=rollouts, iterations=12, depth=3, learning=False)["search"]
        self.assertEqual(deep["exploredDepth"], 3)
        self.assertTrue(any(len(n["path"]) == 3 and n["visits"] for n in deep["nodes"]))
        self.assertEqual(before, self.snapshot())
        bad = copy.deepcopy(candidates)
        bad[0]["assessment"]["fruitages"]["love"] = 1
        self.assert_code("COVENANT_REJECTED", lambda: self.call("search", input=ex["input"], perspectives=bad))

    def test_search_receipt_is_bounded_preserved_and_not_scoring_authority(self):
        ex = self.exchange()
        perspective = {"name": "Skeptic", "summary": ex["output"], "scores": ex["scores"], "assessment": ex["assessment"]}
        search = self.call("search", input=ex["input"], perspectives=[perspective], depth=2,
                           rollouts=[{**perspective, "path": ["Skeptic", "Verification"]}])["search"]
        search["modelRollouts"] = 1
        search["arbitraryExtra"] = {"untrusted": "must not persist"}
        self.commit(search=search)
        stored = self.call("inspect")["history"][-1]["search"]
        self.assertEqual(stored["modelRollouts"], 1)
        self.assertEqual(stored["exploredDepth"], 2)
        self.assertIn("not an independent", stored["provenance"])
        self.assertNotIn("arbitraryExtra", stored)
        bad = copy.deepcopy(search)
        bad["nodes"][0]["value"] = float("nan")
        before = self.snapshot()
        self.assert_code("INVALID_SEARCH", lambda: self.commit(search=bad))
        self.assertEqual(before, self.snapshot())
        poor = copy.deepcopy(ex["assessment"])
        poor["fruitages"]["love"] = 0
        self.assert_code("COVENANT_REJECTED", lambda: self.commit(search=search, assessment=poor))

    def test_memory_actions_filter_unreleased_sources_and_paginate_canonical_evidence(self):
        tc = bridge.Timechain(self.root)
        valid = []
        for i in range(43):
            valid.append(tc.seal("experience", {"summary": f"Measurement sample count item {i} at the laboratory."},
                                 poi=self.exchange()["scores"])["index"])
        hidden = tc.seal("turn", {"event": "web_chat_turn", "summary": "Hidden unreleased laboratory secret."},
                         poi=self.exchange()["scores"])
        result = self.call("memory", action="fetch", rings=valid, budgetChars=64000, learning=False)
        self.assertEqual(len(result["availableEvidence"]), 40)
        self.assertEqual(result["coverage"]["nextCursor"], 40)
        self.assertFalse(result["coverage"]["complete"])
        tail = self.call("memory", action="fetch", rings=valid, cursor=40, budgetChars=64000, learning=False)
        self.assertEqual(len(tail["availableEvidence"]), 3)
        self.assertFalse(tail["coverage"]["complete"])
        self.assertTrue(tail["coverage"]["hasPrevious"])
        for action in ("evidence", "grep", "gather", "track", "endpoints"):
            with self.subTest(action=action):
                out = self.call("memory", action=action, query="laboratory", a="sample", b="laboratory", learning=False)
                self.assertNotIn("Hidden unreleased", out["context"])
                self.assertNotIn(hidden["index"], [e["index"] for e in out["availableEvidence"]])
                self.assertFalse(out["coverage"]["complete"])
        self.assert_code("EVIDENCE_INVALID", lambda: self.call("memory", action="fetch", rings=[hidden["index"]]))

    def test_route_only_offers_replay_and_requires_review_and_fresh_derivation(self):
        import replay
        result = self.commit(input="Recall patient clear reasoning", output="Patient clear reasoning helps us examine uncertainty carefully.")
        ring = result["ring"]["index"]
        route = self.call("route", input="patient clear reasoning", learning=False)["route"]
        self.assertEqual(route["decision"], "REPLAY")
        self.assertTrue(route["requiresReview"])
        self.assertEqual(route["antecedent"]["ring"], ring)
        manager = replay.Replay(self.root, registry_root=self.root)
        manager._save_ledger({str(ring): {"since_fresh": 999, "accepts": 999}})
        route = self.call("route", input="patient clear reasoning", learning=False)["route"]
        self.assertNotEqual(route["decision"], "REPLAY")

    def test_shaped_memory_local_embeddings_temporal_resolution_and_span_guard(self):
        tc = bridge.Timechain(self.root)
        ring = tc.seal("experience", {"summary": "Measured samples contained 11 observations on Monday."},
                       poi=self.exchange()["scores"])
        memory = self.call("memory", query="How many observations were measured?", shapes=["aggregate"],
                           embed=True, learning=False)
        self.assertEqual(memory["result"]["shapes"], ["aggregate"])
        self.assertIn("native", memory["result"])
        self.assertIsNotNone(memory["result"]["embedding"])
        json.dumps(memory)
        resolved = self.call("memory", action="resolve", query="last week", askedOn="2026-10-28")
        self.assertIn("2026", json.dumps(resolved["result"]))
        guarded = self.call("memory", action="span_guard", input="What was measured?",
                            output="Measured samples contained 11 observations.", usedRings=[ring["index"]])
        self.assertTrue(guarded["result"])
        self.assertEqual(guarded["availableEvidence"][0]["index"], ring["index"])

    def test_hibernate_wake_reviewed_preview_and_append_only_epochs(self):
        self.import_pack()
        faculty = next(f for f in self.call("inspect")["faculties"] if f["source"] == "imported")
        before = self.snapshot()
        preview = self.call("faculty_action", action="hibernate", key=faculty["key"], preview=True)
        self.assertEqual(preview["plan"]["faculty"]["key"], faculty["key"])
        self.assertEqual(before, self.snapshot())
        request = {"action": "hibernate", "key": faculty["key"], "expectedHead": self.head(),
                   "scores": self.exchange()["scores"], "assessment": self.exchange()["assessment"]}
        self.assert_code("CONFIRMATION_REQUIRED", lambda: self.call("faculty_action", **request))
        self.call("faculty_action", confirmed=True, **request)
        dormant = next(f for f in self.call("inspect")["faculties"] if f["key"] == faculty["key"])
        self.assertTrue(dormant["dormant"])
        self.assertTrue(dormant["canWake"])
        self.call("faculty_action", **{**request, "action": "wake", "confirmed": True, "expectedHead": self.head()})
        self.assertFalse(next(f for f in self.call("inspect")["faculties"] if f["key"] == faculty["key"])["dormant"])
        self.assertTrue((self.root / "chain" / "rings.jsonl").read_bytes().startswith(before[str(Path("chain") / "rings.jsonl")]))
        self.assertTrue(self.call("verify")["verified"])

    def test_native_promotion_preserves_emergent_and_refuses_authored_code(self):
        import cambium
        entry = {"eid": "new-sense", "kind": "sense", "name": "Careful Measurement",
                 "function": "Notice uncertainty in measured observations.", "category": "knowledge",
                 "recurrence": 3, "seed_terms": ["measurement", "uncertainty"], "status": "emergent"}
        cambium.save_emergent(self.root, {"registry": "emergent", "faculties": [entry]})
        ex = self.exchange()
        self.call("faculty_action", action="promote", key="emergent:new-sense", confirmed=True,
                  expectedHead=self.head(), scores=ex["scores"], assessment=ex["assessment"])
        self.assertEqual(cambium.load_emergent(self.root)["faculties"][0]["status"], "promoted")
        self.assertTrue(any(f["name"] == entry["name"] and f["source"] == "grown" for f in self.call("inspect")["faculties"]))
        entry = {**entry, "eid": "code-sense", "op_code": "raise RuntimeError('never run')"}
        cambium.save_emergent(self.root, {"registry": "emergent", "faculties": [entry]})
        before = self.snapshot()
        self.assert_code("FACULTY_ACTION_BLOCKED", lambda: self.call("faculty_action", action="promote", key="emergent:code-sense", preview=True))
        self.assertEqual(before, self.snapshot())

    def test_teaching_accepts_only_equipped_faculties_and_preserves_history(self):
        faculty = next(f for f in self.call("inspect")["faculties"] if f["kind"] == "modality")
        request = {**self.exchange(), "expectedHead": self.head(), "loadout": [faculty["key"]],
                   "labels": {"modalities": [faculty["name"]], "senses": []}}
        history = (self.root / "chain" / "rings.jsonl").read_bytes()
        result = self.call("teach", **request)
        self.assertTrue(result["extractorTaught"])
        self.assertEqual((self.root / "chain" / "rings.jsonl").read_bytes(), history)
        from extractor import collect_pairs
        self.assertEqual(len(collect_pairs(self.root)), 1)
        self.assert_code("INVALID_LOADOUT", lambda: self.call("teach", **{**request, "labels": {"modalities": ["invented"]}}))
        self.assert_code("INVALID_LOADOUT", lambda: self.call("teach", **{**request, "loadout": []}))

    def test_maintenance_preview_training_holdout_and_dream_are_native(self):
        before = self.snapshot()
        preview = self.call("maintenance", action="train", preview=True)
        self.assertIn("holdout", preview["plan"]["description"])
        self.assertEqual(before, self.snapshot())
        for action in ("train", "index", "dream"):
            ex = self.exchange()
            out = self.call("maintenance", action=action, confirmed=True, expectedHead=self.head(),
                            scores=ex["scores"], assessment=ex["assessment"])
            self.assertTrue(self.call("verify")["verified"])
            if action == "train":
                self.assertFalse(out["report"]["extractor"]["adopted"])
                self.assertFalse(out["report"]["scorer"]["adopted"])
            elif action == "dream":
                self.assertTrue(out["report"]["ran"])
            self.assertFalse((self.root / "chain" / "MAINTENANCE_PENDING.json").exists())

    def scorer_training_report(self):
        import learner
        return {"weights": {"bias": 0.0, **{feature: 0.0 for feature in learner.FEATURES}},
                "offers": 10000, "train_offers": 8000, "holdout_offers": 2000,
                "examples": 10000, "positives": 1000, "features": list(learner.FEATURES),
                "eval": {"trained_mrr": 1.0, "hand_mrr": 0.1, "ranked_holdout_offers": 20}}

    def run_maintenance(self, action="train"):
        ex = self.exchange()
        return self.call("maintenance", action=action, confirmed=True, expectedHead=self.head(),
                         scores=ex["scores"], assessment=ex["assessment"])

    def test_operator_seal_failure_leaves_recovery_evidence_and_holds_future_writes(self):
        import learner
        before = (self.root / "chain" / "rings.jsonl").read_bytes()
        seal = bridge.Timechain._seal_locked
        def fail_operator(instance, ring_type, *args, **kwargs):
            if ring_type == "operator":
                raise OSError("injected native adoption seal failure")
            return seal(instance, ring_type, *args, **kwargs)
        with patch.object(learner, "train_scorer", return_value=self.scorer_training_report()), \
                patch.object(bridge.Timechain, "_seal_locked", fail_operator):
            self.assert_code("MAINTENANCE_INCOMPLETE", self.run_maintenance)
        self.assertTrue(learner.scorer_path(self.root).exists())
        self.assertEqual((self.root / "chain" / "rings.jsonl").read_bytes(), before)
        state = self.call("inspect")
        self.assertTrue(state["locked"])
        self.assertTrue(state["maintenancePending"])
        transaction = self.root / "chain" / "maintenance-transactions" / state["maintenancePending"]["id"]
        journal = json.loads((transaction / "transaction.json").read_text(encoding="utf-8"))
        self.assertEqual(journal["stage"], "needs-review")
        self.assertEqual(journal["sealFailures"][0]["ringType"], "operator")
        for op in ("prepare", "route", "memory", "commit", "teach", "maintenance", "faculty_action", "ingest"):
            with self.subTest(op=op):
                self.assert_code("MAINTENANCE_INCOMPLETE", lambda: self.call(op, input="Resume work."))
        with self.assertRaises(RuntimeError):
            bridge.Timechain(self.root).seal("experience", {"summary": "Native CLI also respects the lockdown."})

    def test_dream_swallowed_operator_error_cannot_release_uncommitted_weights(self):
        import learner
        before = (self.root / "chain" / "rings.jsonl").read_bytes()
        seal = bridge.Timechain._seal_locked
        def fail_operator(instance, ring_type, *args, **kwargs):
            if ring_type == "operator":
                raise OSError("Dream catches this native operator failure")
            return seal(instance, ring_type, *args, **kwargs)
        with patch.object(learner, "train_scorer", return_value=self.scorer_training_report()), \
                patch.object(bridge.Timechain, "_seal_locked", fail_operator):
            self.assert_code("MAINTENANCE_INCOMPLETE", lambda: self.run_maintenance("dream"))
        self.assertTrue((self.root / "chain" / "rings.jsonl").read_bytes().startswith(before))
        self.assertTrue(self.call("inspect")["locked"])
        self.assert_code("MAINTENANCE_INCOMPLETE", lambda: self.call("prepare", input="Read with new weights."))

    def test_missing_operator_receipt_is_detected_even_without_an_exception(self):
        import learner
        def uncommitted(root, report, registry_root=None):
            learner.scorer_path(registry_root).write_text(json.dumps({"status": "active", "weights": {"bias": 1}}), encoding="utf-8")
            return {"adopted": True}
        with patch.object(learner, "adopt_scorer", uncommitted):
            self.assert_code("MAINTENANCE_INCOMPLETE", self.run_maintenance)
        self.assertTrue(self.call("inspect")["locked"])

    def test_abrupt_process_exit_leaves_durable_marker_honored_after_restart(self):
        request = {"op": "maintenance", "root": str(self.root), "action": "train", "confirmed": True,
                   "expectedHead": self.head(), "scores": self.exchange()["scores"], "assessment": self.exchange()["assessment"]}
        script = """import contextlib,io,json,os,sys
import engine_bridge as b
import learner
def crash(root, report, registry_root=None):
    learner.scorer_path(registry_root).write_text('{"status":"active","weights":{"bias":1}}',encoding='utf-8')
    os._exit(17)
learner.adopt_scorer=crash
with contextlib.redirect_stdout(io.StringIO()): b.dispatch(json.load(sys.stdin))
"""
        child = subprocess.run([sys.executable, "-c", script], cwd=PRODUCT, input=json.dumps(request), text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        self.assertEqual(child.returncode, 17)
        state = self.call("inspect")
        self.assertTrue(state["locked"])
        operation = {"op": "prepare", "root": str(self.root), "input": "Continue after crash."}
        restarted = subprocess.run([sys.executable, str(PRODUCT / "engine_bridge.py")], input=json.dumps(operation),
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=True)
        result = json.loads(restarted.stdout)
        self.assertEqual(result["error"]["code"], "MAINTENANCE_INCOMPLETE")

    def test_successful_native_adoption_and_config_state_are_anchored_before_unblock(self):
        import learner
        with patch.object(learner, "train_scorer", return_value=self.scorer_training_report()):
            result = self.run_maintenance()
        self.assertTrue(result["report"]["scorer"]["adopted"])
        self.assertFalse(self.call("inspect")["locked"])
        ring = bridge.Timechain(self.root)._tail_ring()
        digest = hashlib.sha256(learner.scorer_path(self.root).read_bytes()).hexdigest()
        self.assertEqual(ring["payload"]["stateAfter"]["registry/scorer.json"], digest)
        self.assertTrue(any(ref["hash"] == digest for ref in ring["blockspace_refs"]))

    def test_final_journal_failure_preserves_committed_history_and_holds_agent(self):
        before = (self.root / "chain" / "rings.jsonl").read_bytes()
        write = bridge.durable_json
        def fail_receipt(path, value):
            if value.get("stage") == "committed":
                raise OSError("injected transaction receipt write failure")
            return write(path, value)
        with patch.object(bridge, "durable_json", fail_receipt):
            self.assert_code("MAINTENANCE_INCOMPLETE", self.run_maintenance)
        tc = bridge.Timechain(self.root)
        self.assertTrue(tc.rings_path.read_bytes().startswith(before))
        self.assertEqual(tc._tail_ring()["ring_type"], "maintenance-control")
        self.assertTrue(tc.verify()[0])
        self.assertTrue(self.call("inspect")["locked"])


if __name__ == "__main__":
    unittest.main()
