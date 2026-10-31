"""Fresh-chain identity grounding without treating runtime data as experience."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

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
        self.assertEqual(prepared["trustedAgentContext"], trusted)
        self.assertEqual(trusted["version"], 1)
        self.assertEqual(trusted["name"], "Cypher Tempre")
        self.assertEqual(trusted["genesisHash"], inspected["genesis"]["hash"])
        self.assertEqual(trusted["runtime"]["chronosynapticMaxPerspectives"], 21)
        self.assertFalse(trusted["runtime"]["externalActionTools"])
        self.assertEqual(prepared["availableEvidence"], [])

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
        self.assertEqual(prepared["trustedAgentContext"], state["trustedAgentContext"])


if __name__ == "__main__":
    unittest.main()
