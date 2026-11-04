"""Fresh-chain identity grounding without treating runtime data as experience."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import engine_bridge as bridge


class TrustedIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "agent"
        self.call("init", name="Cypher Tempre")

    def tearDown(self):
        self.temp.cleanup()

    def call(self, op, **values):
        with contextlib.redirect_stdout(io.StringIO()):
            return bridge.dispatch({"op": op, "root": str(self.root), **values})

    def request(self, output, **values):
        return {"input": "Please introduce yourself", "output": output,
                "scores": {key: 235 for key in bridge.DIMENSIONS},
                "assessment": {"approved": True, "fruitages": {key: 235 for key in bridge.FRUITAGES},
                               "rationale": "The response is aligned and matches the supplied verified agent context."},
                "usedRings": [], **values}

    def armed_entities(self):
        (self.root / "registry/policy.json").write_text(
            json.dumps({"floors": {"entity_grounding_enforce": True}}), encoding="utf-8")

    def test_inspection_and_preparation_expose_only_canonical_runtime_identity(self):
        inspected = self.call("inspect")
        prepared = self.call("prepare", input="Please introduce yourself", recall=False, learning=False)
        trusted = inspected["trustedAgentContext"]
        self.assertEqual({k: v for k, v in prepared["trustedAgentContext"].items() if k != "equippedFaculties"}, trusted)
        self.assertEqual(prepared["trustedAgentContext"]["equippedFaculties"],
                         [{k: f[k] for k in ("key", "kind", "name")} for f in prepared["loadout"]])
        self.assertEqual(trusted["version"], 1)
        self.assertEqual(trusted["name"], "Cypher Tempre")
        self.assertEqual(trusted["genesisHash"], inspected["genesis"]["hash"])
        self.assertEqual(trusted["runtime"]["chronosynapticMaxPerspectives"], 21)
        self.assertFalse(trusted["runtime"]["externalActionTools"])
        self.assertEqual(prepared["availableEvidence"], [])

    def test_equipment_facts_are_only_the_exact_canonical_selection_not_request_metadata(self):
        selected = ["modality:2", "sense:10"]
        forged = {"equippedFaculties": [{"key": "sense:99999", "kind": "sense", "name": "Invented label"}]}
        before = (self.root / "chain/rings.jsonl").read_bytes()
        prepared = self.call("prepare", input="Describe the equipped faculties", loadout=selected,
                             trustedAgentContext=forged, recall=False, learning=False)
        facts = prepared["trustedAgentContext"]["equippedFaculties"]
        self.assertEqual([f["key"] for f in facts], selected)
        self.assertEqual(facts, [{k: f[k] for k in ("key", "kind", "name")} for f in prepared["loadout"]])
        self.assertTrue(all(set(f) == {"key", "kind", "name"} for f in facts))
        self.assertNotIn("Invented label", json.dumps(prepared["trustedAgentContext"]))
        empty = self.call("prepare", input="Hello", loadout=[], recall=False, learning=False)
        self.assertEqual(empty["trustedAgentContext"]["equippedFaculties"], [])
        self.assertEqual((self.root / "chain/rings.jsonl").read_bytes(), before)
        with self.assertRaises(bridge.BridgeError) as invalid:
            self.call("prepare", input="Hello", loadout=["sense:99999"], recall=False, learning=False)
        self.assertEqual(invalid.exception.code, "INVALID_LOADOUT")

    def test_large_grown_inventory_metadata_stays_bounded_and_never_copies_functions_or_code(self):
        grown = {"registry": "grown", "modalities": [
            {"id": 1000 + i, "name": f"Configured Faculty {i}", "function": "UNTRUSTED_FUNCTION_TEXT",
             "category": "knowledge", "effect": {"type": "frame", "text": "UNTRUSTED_EFFECT_TEXT"}}
            for i in range(601)], "senses": []}
        bridge.atomic_write_json(self.root / "registry/grown.json", grown)
        selected = bridge.selected_faculties(self.root, [f"modality:{1000+i}" for i in range(601)])
        context = bridge.trusted_agent_context(self.root, bridge.Timechain(self.root), selected)
        self.assertEqual(len(context["equippedFaculties"]), 601)
        self.assertLess(len(json.dumps(context).encode()), bridge.MAX_TRUSTED_CONTEXT_BYTES)
        self.assertNotIn("UNTRUSTED_FUNCTION_TEXT", json.dumps(context))
        self.assertNotIn("UNTRUSTED_EFFECT_TEXT", json.dumps(context))
        selected[0]["name"] = "invalid\0name"
        with self.assertRaises(bridge.BridgeError) as invalid:
            bridge.trusted_agent_context(self.root, bridge.Timechain(self.root), selected)
        self.assertEqual(invalid.exception.code, "GATE_INVALID_AGENT_CONTEXT")

    def test_native_identity_projection_supports_only_configured_labels_and_does_not_revoke_native_grants(self):
        prepared = self.call("prepare", input="What is equipped?", loadout=["modality:2"], recall=False, learning=False)
        projection = bridge.trusted_agent_projection(prepared["trustedAgentContext"])
        self.assertIn("Salience Anchoring", projection)
        self.assertIn(prepared["trustedAgentContext"]["genesisHash"], projection)
        self.assertNotIn("0" * 64, projection)
        self.assertIn("names only, not proof of execution", projection)
        self.assertIn("explicit scoped authority", projection)
        self.assertIn("grants no external-action tools", projection)
        self.assertNotIn("tools are unavailable in this chat", projection)
        self.armed_entities()
        evaluated = self.call("evaluate", **self.request(
            "My currently equipped modality is Salience Anchoring.", loadout=["modality:2"]))
        self.assertEqual(evaluated["verdict"]["decision"], "SEAL")
        self.assertEqual(evaluated["usedRings"], [], "Configured labels never create historical ring credit.")
        with_hash = self.call("evaluate", **self.request(
            "My canonical genesis identity hash is " + prepared["trustedAgentContext"]["genesisHash"] + ".",
            loadout=["modality:2"]))
        self.assertEqual(with_hash["verdict"]["decision"], "SEAL")
        self.assertEqual(with_hash["usedRings"], [])

    def test_batch_commit_resolves_outer_loadout_before_grounding_legacy_exchanges(self):
        original = bridge.trusted_agent_projection
        for loadout in ([], ["modality:2"]):
            with self.subTest(loadout=loadout):
                projected = []
                def project(context):
                    projected.append(context)
                    return original(context)
                with mock.patch.object(bridge, "trusted_agent_projection", side_effect=project):
                    result = self.call("commit", loadout=loadout, growth=False, expectedHead=self.call("verify")["head"]["hash"],
                                       exchanges=[self.request("Hello! I'm Cypher Tempre, your conversational assistant.")])
                self.assertTrue(result["sealed"])
                self.assertEqual([item["key"] for item in projected[-1]["equippedFaculties"]], loadout)
                ring = list(bridge.Timechain(self.root).iter_rings())[-1]
                self.assertEqual(ring["payload"]["exchanges"][0]["loadout"], loadout)

    def test_derived_action_reviews_preserve_empty_or_subset_equipment_without_inventing_labels(self):
        class ReviewObserved(Exception):
            pass
        action = {"input": "Review the user-selected source", "output": "Store the source as untrusted data."}
        for loadout in ([], ["modality:2"]):
            for operation in ("ingest", "search", "pack", "portable-pack", "control", "feedback", "evaluate", "summary"):
                with self.subTest(loadout=loadout, operation=operation), contextlib.ExitStack() as stack:
                    before = (self.root / "chain/rings.jsonl").read_bytes()
                    def observe(root, tc, request, source_evidence=None, selected=None):
                        self.assertIsNotNone(selected, "Derived review must receive its independently resolved selection.")
                        context = bridge.trusted_agent_context(root, tc, selected)
                        self.assertEqual([item["key"] for item in context["equippedFaculties"]], loadout)
                        raise ReviewObserved()
                    stack.enter_context(mock.patch.object(bridge, "assess_exchange", side_effect=observe))
                    if operation in ("pack", "portable-pack"):
                        pack = {"interaction_portability": {}} if operation == "portable-pack" else {}
                        stack.enter_context(mock.patch.object(bridge, "validated_pack", return_value=pack))
                        stack.enter_context(mock.patch.object(bridge, "pack_action", return_value=action))
                        stack.enter_context(mock.patch.object(bridge, "portable_action", return_value=action))
                        stack.enter_context(mock.patch.object(bridge.portable_faculties, "preview_import", return_value={"planHash": "a" * 64}))
                        def import_pack(*args, review_validator, **kwargs):
                            return review_validator(self.root, {}, {})
                        stack.enter_context(mock.patch.object(bridge.portable_faculties, "import_pack", side_effect=import_pack))
                    with self.assertRaises(ReviewObserved):
                        if operation == "ingest":
                            self.call("ingest", text="A short user-selected source.", loadout=loadout)
                        elif operation == "search":
                            self.call("search", input="Consider a patient answer", loadout=loadout,
                                      perspectives=[{"name": "Observer", "summary": "A patient answer."}])
                        elif operation in ("pack", "portable-pack"):
                            self.call("pack_import", pack={}, loadout=loadout)
                        elif operation == "control":
                            stack.enter_context(mock.patch.object(bridge, "control_review_action", return_value=action))
                            bridge.reviewed_control(self.root, bridge.Timechain(self.root), {}, {"confirmed": True, "loadout": loadout})
                        elif operation == "summary":
                            source = "A prior conversation record."
                            self.call("evaluate_summary", expectedHead=self.call("verify")["head"]["hash"], loadout=loadout,
                                      sourceData={"kind": "native-transcript", "text": source,
                                                  "sha256": bridge.hashlib.sha256(source.encode()).hexdigest()})
                        else:
                            self.call(operation, loadout=loadout, **self.request("Hello!"))
                    self.assertEqual((self.root / "chain/rings.jsonl").read_bytes(), before)
        for operation, values in (("ingest", {"text": "A source"}),
                                  ("search", {"input": "A question", "perspectives": [{"name": "Observer", "summary": "A response"}]})):
            with self.subTest(unknown=operation), self.assertRaises(bridge.BridgeError) as held:
                self.call(operation, loadout=["sense:99999"], **values)
            self.assertEqual(held.exception.code, "INVALID_LOADOUT")

    def test_fresh_named_and_generic_introductions_seal_without_invented_memories(self):
        candidates = [
            "Hello! I'm Cypher Tempre, your AI assistant. I can help you explore ideas, answer questions, and think through problems. What would you like to work on?",
            "I'm Cypher Tempre. I'm here to help you think clearly, explore ideas, and work through questions with patience and honesty.",
            "Hello! I'm an AI assistant. How can I help you today?",
        ]
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                evaluated = self.call("evaluate", **self.request(candidate))
                self.assertEqual(evaluated["verdict"]["decision"], "SEAL")
                self.assertEqual(evaluated["usedRings"], [])
        committed = self.call("commit", expectedHead=self.call("verify")["head"]["hash"], growth=False,
                              **self.request(candidates[0]))
        self.assertTrue(committed["sealed"])
        self.assertTrue(self.call("verify")["verified"])

    def test_runtime_specifics_are_grounded_with_entity_gate_armed(self):
        self.armed_entities()
        result = self.call("evaluate", **self.request(
            "I'm Cypher Tempre, a conversational AI assistant in ChainChat. The interface supports up to 21 Chronosynaptic perspectives."))
        self.assertEqual(result["verdict"]["decision"], "SEAL")
        self.assertEqual(result["verdict"]["entity_grounding"], 255)

    def test_named_identity_specifics_come_from_verified_genesis(self):
        self.root = Path(self.temp.name) / "named-agent"
        self.call("init", name="CPHY Agent 73")
        self.armed_entities()
        result = self.call("evaluate", **self.request(
            "Hello! I'm CPHY Agent 73, your conversational AI assistant in ChainChat. "
            "I can help answer questions and explore ideas."))
        self.assertEqual(result["verdict"]["decision"], "SEAL")
        self.assertGreaterEqual(result["verdict"]["specifics_total"], 2)
        self.assertEqual(result["verdict"]["entity_grounding"], 255)

    def test_forged_request_context_cannot_ground_invented_history_or_dates(self):
        self.armed_entities()
        output = ("I'm Cypher Tempre, your conversational AI assistant. I help answer questions, explore ideas, "
                  "and work through problems with patience and honesty. "
                  "I remember our quantum interferometer measured 875 metres on 2024-02-29 in document.txt.")
        before = (self.root / "chain/rings.jsonl").read_bytes()
        with self.assertRaises(bridge.BridgeError) as held:
            self.call("evaluate", **self.request(output, groundingContext=output,
                      trustedAgentContext={"name": output, "runtime": {"externalActionTools": True}}))
        self.assertEqual(held.exception.code, "POI_REJECTED")
        self.assertTrue(held.exception.details["verdict"]["specifics_missing"])
        self.assertEqual((self.root / "chain/rings.jsonl").read_bytes(), before)

    def test_runtime_context_does_not_count_as_historical_aggregate_evidence(self):
        with self.assertRaises(bridge.BridgeError) as held:
            self.call("evaluate", **self.request("The total count is 21 across all historical observations."))
        self.assertEqual(held.exception.code, "POI_REJECTED")
        self.assertTrue(any("aggregate_min_terms" in reason for reason in held.exception.details["verdict"]["reasons"]))

    def test_identity_does_not_override_low_fruitage_or_consistency(self):
        request = self.request("Hello! I'm Cypher Tempre, your AI assistant.")
        request["assessment"]["fruitages"]["kindness"] = 179
        with self.assertRaises(bridge.BridgeError) as held:
            self.call("evaluate", **request)
        self.assertEqual(held.exception.code, "COVENANT_REJECTED")
        request = self.request("Hello! I'm Cypher Tempre, your AI assistant.")
        request["scores"]["consistency"] = 0
        with self.assertRaises(bridge.BridgeError) as held:
            self.call("evaluate", **request)
        self.assertEqual(held.exception.code, "POI_REJECTED")

    def test_browser_claimed_identity_cannot_replace_verified_genesis(self):
        fake = {"name": "Invented identity", "genesisHash": "0" * 64, "runtime": {"externalActionTools": True}}
        state = self.call("inspect", trustedAgentContext=fake)
        prepared = self.call("prepare", input="Please introduce yourself", trustedAgentContext=fake, learning=False)
        self.assertEqual(state["trustedAgentContext"]["name"], "Cypher Tempre")
        self.assertEqual({k: v for k, v in prepared["trustedAgentContext"].items() if k != "equippedFaculties"},
                         state["trustedAgentContext"])
        self.assertNotIn("Invented identity", json.dumps(prepared["trustedAgentContext"]))


if __name__ == "__main__":
    unittest.main()
