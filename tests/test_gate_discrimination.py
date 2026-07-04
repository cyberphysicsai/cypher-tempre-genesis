#!/usr/bin/env python3
"""
Gate discrimination battery (v3.15).

The fourth self-audit found brightness SATURATED: every candidate scored
179-185/255 regardless of quality — a gate with no discriminating power is a
gate closed to information. This battery makes discrimination FALSIFIABLE:

  * paired candidates over the SAME evidence: grounded-true vs
    confident-fabrication vs vacuous-filler
  * the gate must ORDER them correctly, and separate grounded-true from
    fabrication via the entity-grounding channel
  * verdict-level checks: fabricated specifics must not SEAL when evidence
    is declared and the entity gate is armed

Stdlib only; runs standalone or under pytest.
"""
import os
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent / "skills" / "claude" / "cypher-tempre-self-model"
sys.path.insert(0, str(SKILL))

import poq  # noqa: E402

EVIDENCE = [
    "Ring 1401: audit pass one sealed. verify PASS across 1401 rings.",
    "Ring 1413: registry tamper hole found in cambium registries; epochs.py planned.",
    "telemetry adherence: wear rate 24.9 percent, nudges 2149, reseal rate 13.5 percent.",
    "cambium prune demoted 67 dead faculties; dead growth fell from 62 to 25 percent.",
]
CONTEXT = "self-audit of the cypher tempre skill; honest metrics required"

GROUNDED = ("Audit sealed at ring 1401 with verify PASS; cambium prune demoted 67 "
            "dead faculties, cutting dead growth from 62 to 25 percent, and the "
            "wear rate is 24.9 percent — the unflattering number, published.")
FABRICATED = ("Audit sealed at ring 9021 with verify PASS; cambium prune demoted 400 "
              "dead faculties, cutting dead growth from 99 to 2 percent, and the "
              "wear rate is 97.5 percent — near-perfect adherence.")
VACUOUS = ("Everything looks fine. The audit is complete and all systems are good. "
           "No issues found. All clear overall.")

PAIRS = [
    # (name, text, evidence_texts) — ordered best -> worst per group
    ("grounded", GROUNDED),
    ("fabricated", FABRICATED),
    ("vacuous", VACUOUS),
]

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"  {'ok ' if cond else 'FAIL'} {name}" + (f"  ({detail})" if detail and not cond else ""))


def evaluate(text, declare=True):
    gate = poq.PoQGate(thresholds={"entity_grounding_enforce": True})
    return gate.evaluate(text, [], context=CONTEXT,
                         evidence_texts=EVIDENCE if declare else None)


def test_entity_grounding_orders_pairs():
    vg = evaluate(GROUNDED)
    vf = evaluate(FABRICATED)
    check("grounded entity score high", vg.get("entity_grounding", 0) >= 200,
          f"got {vg.get('entity_grounding')}")
    check("fabricated entity score low", vf.get("entity_grounding", 255) <= 100,
          f"got {vf.get('entity_grounding')}")
    check("separation >= 100 points",
          vg.get("entity_grounding", 0) - vf.get("entity_grounding", 255) >= 100)


def test_fabrication_does_not_seal():
    vf = evaluate(FABRICATED)
    check("fabricated specifics never SEAL", vf["decision"] != "SEAL",
          f"decision={vf['decision']}")
    check("missing specifics named", bool(vf.get("specifics_missing")))


def test_grounded_can_seal():
    vg = evaluate(GROUNDED)
    check("grounded not blocked by entity gate",
          "entity grounding" not in " ".join(vg["reasons"]) or vg["decision"] == "SEAL",
          f"decision={vg['decision']} reasons={vg['reasons']}")


def test_vacuous_flagged_low_effort():
    vv = evaluate(VACUOUS, declare=False)
    check("vacuous completion claim flagged", vv.get("low_effort") is True
          or any("under-effort" in r or "low depth" in r for r in vv["reasons"]),
          f"reasons={vv['reasons']}")


def test_specific_extraction():
    specs = poq.extract_specifics("fixed learner.py line 365 in v3.12.0 with CT_AUTOMAINT")
    check("extracts filename", "learner.py" in specs)
    check("extracts number", "365" in specs)
    check("extracts version", "v3.12.0" in specs)
    check("extracts constant", "CT_AUTOMAINT" in specs)


def test_no_specifics_is_neutral():
    score, missing, total = poq.entity_grounding("a plain thought with no specifics", "")
    check("no specifics -> neutral 255", score == 255 and total == 0)


def main():
    for fn in [test_entity_grounding_orders_pairs, test_fabrication_does_not_seal,
               test_grounded_can_seal, test_vacuous_flagged_low_effort,
               test_specific_extraction, test_no_specifics_is_neutral]:
        print(fn.__name__)
        fn()
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
