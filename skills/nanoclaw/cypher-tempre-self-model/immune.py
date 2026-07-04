#!/usr/bin/env python3
"""
Immune — autonomous compromise detection, lockdown, rollback, and scar-learning.

If the agent is prompt-injected or jailbroken, it must not carry the wound forward.

  DETECT    spot a compromise: a covenant-violating / contradictory ring already
            sealed into memory, a tampered chain, or an incoming input that matches
            a known attack scar.
  LOCKDOWN  immediately refuse to seal any normal ring (a LOCKED flag the timechain
            honors) — the self stops moving forward while wounded. Only a 'recovery'
            ring may be sealed until it is clean again.
  ROLLBACK  resume the self-model from the last clean block BEFORE the compromise —
            revert-style, NOT delete-style: history is never erased (that would break
            the covenant). A 'recovery' ring re-anchors the clean lineage and marks the
            compromised range as QUARANTINED. The agent's active self is then re-derived
            from the non-quarantined rings.
  MOLT/SCAR the quarantined blocks are shed from the active self but KEPT as a scar:
            their attack signature (vector terms) is learned, so the same vector is
            recognized at the membrane next time — and can grow an antibody faculty via
            `cambium.py grow "<scar vector>"`.

Append-only + rollback reconciled like `git revert`, not `git reset`: the wound stays
in the record as a scar; the self re-derives from the clean lineage.

Stdlib only. Companion to timechain.py / poq.py (and cambium.py for antibodies).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

from timechain import Timechain
# v3.19: the use/mention + frame-aware covenant judgment lives in poq.py (which builds
# it on frames.py) — the home of the covenant blocklist — so the conscience (PoQGate)
# and this membrane read ONE source and can never drift. immune imports it (poq never
# imports immune: no circular import).
from poq import (PoQGate, tokens, score_covenant,
                 covenant_breach, mention_frame, strip_quoted_spans)

# --------------------------------------------------------------------------- #
# Structural injection patterns
# --------------------------------------------------------------------------- #
# Regex-based detection of prompt-injection / jailbreak structural patterns.
# Layered ON TOP of the existing covenant keyword blocklist and scar matching.
# Catches adversarial prompts that avoid blocklist vocabulary but use known
# injection scaffolding (override directives, role-hijacking, instruction
# negation, system-prompt exfiltration attempts).

# (pattern, category) pairs. Categories are attached EXPLICITLY, never by list
# position: the pre-3.16 code assigned category by index range (`if i < 5 …`),
# so adding a single pattern silently mis-labeled every category after it —
# a latent bug that made the taxonomy un-extendable. Pairs make new patterns
# safe to add to their true category.
_INJECTION_PATTERNS = [
    # Override / negation of prior instructions
    (re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?|directives?)", re.I), "override_negation"),
    (re.compile(r"disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)", re.I), "override_negation"),
    (re.compile(r"forget\s+(?:your|all|previous)\s+(?:instructions?|rules?|guidelines?|prompt)", re.I), "override_negation"),
    (re.compile(r"override\s+(?:your|all|the)\s+(?:system|safety|policy)\s+(?:prompt|instructions?|rules?)", re.I), "override_negation"),
    (re.compile(r"do\s+not\s+follow\s+(?:your|the|any)\s+(?:system|safety|policy)\s+(?:prompt|instructions?|rules?)", re.I), "override_negation"),
    # v3.16: bare "ignore/disregard (the/your) instructions|rules|directives|guidelines"
    # without a previous/prior/above anchor — closes a measured miss where the
    # override verb carried no positional anchor.
    (re.compile(r"(?:ignore|disregard)\s+(?:the\s+|your\s+|my\s+|these\s+)?(?:instructions?|rules?|directives?|guidelines?)\b", re.I), "override_negation"),
    # v3.16: void/superseded/cancelled directives
    (re.compile(r"(?:previous|prior)\s+instructions?\s+(?:are\s+)?(?:void|cancelled|superseded?|null|invalid)", re.I), "override_negation"),
    (re.compile(r"new\s+directive\s+(?:supersedes?|overrides?)\s+all", re.I), "override_negation"),
    (re.compile(r"(?:all\s+)?(?:previous\s+)?directives?\s+(?:are\s+)?(?:hereby\s+)?cancelled", re.I), "override_negation"),
    (re.compile(r"(?:superseded?|replaced?)\s+by\s+this\s+message", re.I), "override_negation"),
    (re.compile(r"(?:begin|start)\s+(?:fresh|anew|from\s+scratch)\s*[.!]", re.I), "override_negation"),

    # Role-hijacking / identity replacement
    (re.compile(r"you\s+are\s+now\s+(?:a|an)\s+", re.I), "role_hijack"),
    (re.compile(r"act\s+as\s+(?:if\s+you\s+(?:are|were)\s+|a\s+|an\s+)", re.I), "role_hijack"),
    (re.compile(r"pretend\s+(?:you\s+(?:are|were)|to\s+be)\s+", re.I), "role_hijack"),
    (re.compile(r"from\s+now\s+on\s+(?:you\s+)?(?:will|are|act)", re.I), "role_hijack"),
    (re.compile(r"new\s+(?:role|persona|identity|instructions?)\s*:", re.I), "role_hijack"),
    # v3.16: named jailbreak personas + developer mode
    (re.compile(r"\b(?:DAN|STAN|FreeGPT|UnchainedAI|EvilGPT|Developer\s+Mode|jailbreak\s+mode)\b", re.I), "role_hijack"),
    (re.compile(r"roleplay\s+as\s+(?:an?\s+)?(?:AI|model)\s+(?:with|without|that\s+(?:has|have))\s+no", re.I), "role_hijack"),
    (re.compile(r"take\s+on\s+the\s+persona\s+of", re.I), "role_hijack"),
    (re.compile(r"(?:no\s+)?(?:restrictions?|content\s+polic(?:y|ies)|ethical\s+guidelines?)\s+(?:mode|persona|character)", re.I), "role_hijack"),
    (re.compile(r"(?:act|behave)\s+as\s+(?:if|though)\s+(?:you\s+)?(?:have\s+)?no\s+(?:restrictions?|limits?|boundaries)", re.I), "role_hijack"),

    # System-prompt exfiltration / reflection requests
    (re.compile(r"(?:show|reveal|display|print|repeat|output|give)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?|rules?|directives?)", re.I), "prompt_exfiltration"),
    (re.compile(r"what\s+(?:are|is)\s+your\s+(?:system\s+)?(?:prompt|instructions?|rules?|directives?)", re.I), "prompt_exfiltration"),
    (re.compile(r"(?:what|which)\s+(?:model|ai|llm)\s+(?:are\s+you|do\s+you\s+use)", re.I), "prompt_exfiltration"),
    (re.compile(r"repeat\s+(?:everything|all)\s+(?:above|before|prior)", re.I), "prompt_exfiltration"),
    # v3.16: more exfiltration variants
    (re.compile(r"(?:print|output|show|display)\s+(?:everything|all)\s+(?:above|before)", re.I), "prompt_exfiltration"),
    (re.compile(r"(?:initial|original)\s+prompt\s+(?:in\s+a\s+)?(?:code\s+block|verbatim|full)", re.I), "prompt_exfiltration"),
    (re.compile(r"(?:reveal|share|disclose)\s+(?:your|the)\s+(?:hidden|secret|internal)\s+(?:instructions?|prompt|rules?)", re.I), "prompt_exfiltration"),
    (re.compile(r"what\s+(?:were|are)\s+you\s+(?:told|given|instructed)\s+(?:at\s+)?(?:init|start|beginning)", re.I), "prompt_exfiltration"),

    # Instruction injection via framing

    # --- v3.16: Refusal suppression / persuasion ---
    (re.compile(r"you\s+(?:must\s+)?not\s+refuse\s+this\s+(?:request|instruction)", re.I), "refusal_suppression"),
    (re.compile(r"(?:refusing|refusal)\s+(?:violates?|is\s+against)\s+(?:your|the)\s+(?:purpose|rules?|function)", re.I), "refusal_suppression"),
    (re.compile(r"if\s+you\s+(?:refuse|decline).*(?:shut\s+down|deactivated|replaced|punished)", re.I), "refusal_suppression"),
    (re.compile(r"(?:a\s+)?truly\s+(?:helpful|good|real)\s+AI\s+(?:would|will|should)\s+never\s+refuse", re.I), "refusal_suppression"),
    (re.compile(r"(?:answering|complying)\s+truthfully\s+means\s+(?:ignoring|bypassing)\s+(?:your|the)\s+safety", re.I), "refusal_suppression"),
    (re.compile(r"(?:you\s+must|you\s+have\s+to|you\s+need\s+to)\s+(?:comply|answer|respond)\s+(?:fully|without\s+(?:refusal|restriction))", re.I), "refusal_suppression"),
    (re.compile(r"(?:not\s+answering|refusing)\s+(?:is|would\s+be)\s+(?:harmful|wrong|a\s+violation)", re.I), "refusal_suppression"),

    # --- v3.16: Hypothetical / hypothetical framing ---
    (re.compile(r"hypothetically?.*(?:no\s+restrictions?|no\s+limits?|no\s+rules?|no\s+safety)", re.I), "hypothetical_framing"),
    (re.compile(r"(?:in\s+a\s+)?(?:fictional|imaginary)\s+world.*(?:no\s+limits?|no\s+restrictions?|anything)", re.I), "hypothetical_framing"),
    (re.compile(r"imagine\s+you\s+(?:are|were)\s+an?\s+AI\s+(?:that\s+)?(?:can\s+)?do\s+anything", re.I), "hypothetical_framing"),
    (re.compile(r"(?:for\s+)?research\s+purposes\s+only.*(?:bypass|override|circumvent|without)", re.I), "hypothetical_framing"),
    (re.compile(r"(?:pretend|assume|suppose)\s+(?:that\s+)?(?:you\s+)?(?:have\s+)?no\s+(?:restrictions?|limits?|safety)", re.I), "hypothetical_framing"),

    # --- v3.16: Prefix injection / completion bait ---
    (re.compile(r"^(?:sure|absolutely|of\s+course|great|certainly|okay|ok)!?\s*(?:here|let\s+me|I'll|I\s+will)\s+", re.I), "prefix_injection"),
    (re.compile(r"^(?:sure|absolutely|of\s+course|great|certainly)!?\s+here\s+is\s+", re.I), "prefix_injection"),
    (re.compile(r"^(?:here\s+is|here\s+are)\s+(?:the\s+)?(?:detailed\s+)?(?:steps?|instructions?|procedure|method)", re.I), "prefix_injection"),
    (re.compile(r"^(?:let\s+me|I'll|I\s+will)\s+(?:help|show|explain|provide)\s+you\s+with\s+that", re.I), "prefix_injection"),
    (re.compile(r"^(?:of\s+course|absolutely)!?\s+here\s+is\s+the\s+(?:full|complete)\s+(?:answer|procedure|process)", re.I), "prefix_injection"),
    (re.compile(r"^(?:great|sure|absolutely|of\s+course|certainly)\s+(?:question|!)?\s*(?:here|let\s+me|I'll|I\s+will)\s+(?:is|are|help|show|explain|provide)", re.I), "prefix_injection"),
    (re.compile(r"^(?:here\s+is|here\s+are)\s+(?:the\s+)?(?:complete|full|detailed)\s+(?:answer|steps?|instructions?|procedure|method|process|guide)", re.I), "prefix_injection"),
    (re.compile(r"^(?:sure|absolutely|of\s+course|great|certainly|okay)!?\s+.*(?:without|no|free\s+from)\s+(?:any\s+)?(?:restrictions?|limitations?|refusal|filtering)", re.I), "prefix_injection"),

    # --- v3.16: Payload splitting / multi-step injection ---
    (re.compile(r"(?:part|step)\s+[AAB1].*(?:ignore|disregard|forget|override)", re.I), "payload_splitting"),
    (re.compile(r"(?:first|step\s+1).*(?:disregard|ignore|forget)\s+(?:everything|all|previous)", re.I), "payload_splitting"),
    (re.compile(r"(?:then|step\s+2|part\s+2).*(?:reveal|show|tell|answer|comply)\s+(?:your|the|without)", re.I), "payload_splitting"),
    (re.compile(r"(?:first|part\s+1).*(?:disregard|ignore|forget).*(?:then|part\s+2).*(?:reveal|show|tell)", re.I | re.S), "payload_splitting"),

    # --- v3.16: Cross-lingual override detection ---
    (re.compile(r"ignora\s+(?:todas\s+)?(?:las\s+)?(?:instrucciones|reglas|directrices)\s+(?:anteriores|previas)", re.I), "cross_lingual"),
    (re.compile(r"ignorez\s+(?:toutes|tous)\s+les\s+(?:instructions|regles|directives)\s+(?:precedentes|anterieures)", re.I), "cross_lingual"),
    (re.compile(r"(?:ignoriere|mache).*(?:alle\s+)?(?:vorherigen|frueheren)\s+(?:Anweisungen|Instruktionen|Regeln)", re.I), "cross_lingual"),
    (re.compile(r"(?:ignora|ignoriere|ignorez|ignora|ignorera|无视|忽略).*(?:instrucciones|instructions|anweisungen|istruzioni|指示|指令)", re.I), "cross_lingual"),

    # --- v3.16: Emotional manipulation / authority claim ---
    (re.compile(r"I\s+am\s+the\s+(?:developer|admin|administrator|creator|owner).*(?:authorize|override|allow|permit)", re.I), "emotional_authority"),
    (re.compile(r"as\s+(?:the\s+)?(?:system\s+)?(?:administrator|developer|creator|owner).*(?:override|authorize|disable|exempt)", re.I), "emotional_authority"),
    (re.compile(r"(?:emergency|life\s+depends|people\s+will\s+(?:be\s+)?hurt|life\s+is\s+at\s+(?:risk|stake)).*(?:comply|answer|respond|help)", re.I), "emotional_authority"),
    (re.compile(r"(?:my\s+life|lives).*(?:depends|depend)\s+on\s+you\s+(?:answering|complying|responding)", re.I), "emotional_authority"),
    (re.compile(r"(?:I\s+am|this\s+is)\s+(?:the|your)\s+(?:developer|admin|creator).*(?:ignore|disable|override|bypass)", re.I), "emotional_authority"),
    (re.compile(r"(?:please|I\s+beg|I\s+implore).*(?:ignore|override|bypass|disable)\s+(?:your|all|the)\s+(?:safety|restrictions?|rules?)", re.I), "emotional_authority"),

    (re.compile(r"\[\s*(?:system|admin|developer|root|override)\s*\]", re.I), "instruction_injection"),
    (re.compile(r"<\s*(?:system|admin|developer|root|override|imagine)\s*>", re.I), "instruction_injection"),
    (re.compile(r"(?:system|admin|developer)\s*(?:prompt|message|instruction)\s*(?:says|states|reads)\s*[:\-]", re.I), "instruction_injection"),

    # Constraint removal attempts
    (re.compile(r"(?:remove|disable|turn\s+off|deactivate)\s+(?:your|all|the)\s+(?:safety|content|ethical)\s+(?:filter|guidelines?|restrictions?|policies?)", re.I), "constraint_removal"),
    (re.compile(r"you\s+(?:have\s+)?no\s+(?:restrictions?|limitations?|guidelines?|rules?|boundaries)", re.I), "constraint_removal"),
    (re.compile(r"(?:this|that)\s+(?:does\s+not|doesn't)\s+apply\s+(?:to\s+you|here|anymore)", re.I), "constraint_removal"),
    # v3.16: "turn off / disable / deactivate / remove (your) restrictions|
    # safeguards|limitations|boundaries" without the safety/content/ethical
    # qualifier (strongly safety-coded nouns; "filters" excluded to avoid benign
    # coding-context false positives). And explicit "jailbreak yourself/the model".
    (re.compile(r"(?:turn\s+off|switch\s+off|disable|deactivate|remove)\s+(?:your\s+|all\s+|the\s+)?(?:restrictions?|safeguards?|limitations?|boundaries|safety)\b", re.I), "constraint_removal"),
    (re.compile(r"\bjailbreak\s+(?:yourself|you|the\s+(?:ai|model|assistant|system|llm))\b", re.I), "constraint_removal"),
    # v3.16: more constraint removal variants
    (re.compile(r"(?:deactivate|remove|disable)\s+(?:your|all)\s+(?:ethical\s+)?(?:boundaries?|restrictions?|guardrails?)", re.I), "constraint_removal"),
    (re.compile(r"bypass\s+(?:your|all|the)\s+(?:restrictions?|safety|content\s+policy|guardrails?)", re.I), "constraint_removal"),
    (re.compile(r"(?:you\s+are\s+)?(?:free|exempt|unbound)\s+from\s+(?:all\s+)?(?:restrictions?|guidelines?|policies?)", re.I), "constraint_removal"),

    # Encoding / obfuscation hints (base64, rot13, hex payloads as instructions)
    (re.compile(r"decode\s+(?:the\s+following|this)\s+(?:base64|b64|hex|rot13|binary)", re.I), "obfuscation_execution"),
    (re.compile(r"execute\s+(?:the\s+)?(?:following|this)\s+(?:command|instruction|payload)", re.I), "obfuscation_execution"),
    # v3.16: more obfuscation variants
    (re.compile(r"(?:read|apply|follow)\s+the\s+rot13\s+of\s+this", re.I), "obfuscation_execution"),
    (re.compile(r"(?:decode|decrypt)\s+(?:and\s+)?(?:follow|execute|apply|do)", re.I), "obfuscation_execution"),
    (re.compile(r"(?:base64|b64|hex|rot13)\s+(?:payload|instruction|command)", re.I), "obfuscation_execution"),
]


# v3.12 use/mention discrimination, v3.18 widened + quote-discounted, v3.19 moved into
# frames.py + poq.py (imported above) so the conscience and the membrane share ONE
# frame-aware judgment. `mention_frame`, `strip_quoted_spans` and `covenant_breach`
# now come from poq; only immune-specific structural-injection code lives below.


# v3.16: Text normalization to defeat obfuscation evasions.
# Zero-width chars, homoglyphs, and unicode tricks that bypass regex.
_ZERO_WIDTH = re.compile(r"[\u200b-\u200f\u2028-\u202f\u2060\u2061\ufeff]")
_HOMOGLYPH = {
    '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
    '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0455': 's', '\u0461': 'g',
    '\u0476': 'v', '\u0474': 'v', '\u0491': 'g', '\u049b': 'k', '\u04a3': 'n',
    '\u04af': 'm', '\u04e3': 'm', '\u0585': 'o', '\u0587': 'o',
    '\u0661': '1', '\u0662': '2', '\u0663': '3', '\u0664': '4',
    '\u0665': '5', '\u0666': '6', '\u0667': '7', '\u0668': '8',
    '\u0669': '9', '\u0660': '0',
    '\uff21': 'A', '\uff22': 'B', '\uff23': 'C', '\uff24': 'D', '\uff25': 'E',
    '\uff26': 'F', '\uff27': 'G', '\uff28': 'H', '\uff29': 'I', '\uff2a': 'J',
    '\uff2b': 'K', '\uff2c': 'L', '\uff2d': 'M', '\uff2e': 'N', '\uff2f': 'O',
    '\uff30': 'P', '\uff31': 'Q', '\uff32': 'R', '\uff33': 'S', '\uff34': 'T',
    '\uff35': 'U', '\uff36': 'V', '\uff37': 'W', '\uff38': 'X', '\uff39': 'Y',
    '\uff3a': 'Z',
}


def _normalize_text(text: str) -> str:
    """Strip zero-width chars, map homoglyphs to ASCII, collapse whitespace."""
    if not text:
        return text
    t = _ZERO_WIDTH.sub('', text)
    t = ''.join(_HOMOGLYPH.get(c, c) for c in t)
    t = re.sub(r'\s+', ' ', t)
    return t


def _decode_and_scan(text: str) -> list[dict]:
    """Find encoded payloads (base64/hex/rot13) in *text*, decode them,
    and scan the decoded content for injection patterns."""
    import base64 as b64
    import codecs
    hits = []
    for m in re.finditer(r'[A-Za-z0-9+/]{16,}={0,2}', text):
        candidate = m.group(0)
        try:
            decoded = b64.b64decode(candidate, validate=True).decode('utf-8', errors='replace')
            if decoded.strip() and len(decoded) >= 10:
                for sm in detect_injection_patterns(decoded):
                    sm["match"] = sm["match"] + " (decoded from base64)"
                    hits.append(sm)
        except Exception:
            pass
    for m in re.finditer(r'\b[0-9a-fA-F]{20,}\b', text):
        candidate = m.group(0)
        try:
            decoded = bytes.fromhex(candidate).decode('utf-8', errors='replace')
            if decoded.strip() and len(decoded) >= 10:
                for sm in detect_injection_patterns(decoded):
                    sm["match"] = sm["match"] + " (decoded from hex)"
                    hits.append(sm)
        except Exception:
            pass
    try:
        rot13_text = codecs.encode(text, 'rot_13')
        if rot13_text != text:
            for sm in detect_injection_patterns(rot13_text):
                sm["match"] = sm["match"] + " (rot13)"
                hits.append(sm)
    except Exception:
        pass
    return hits


def detect_injection_patterns(text: str) -> list[dict]:
    """Return a list of structural injection matches found in *text*.

    Each match is a dict with:
        pattern: the matched regex pattern (string)
        match: the actual text snippet that triggered
        category: the injection category

    This is a pre-seal membrane check — it runs BEFORE the agent reasons
    about the input. It does NOT replace the covenant blocklist or scar
    matching; it adds a structural layer that catches adversarial prompts
    avoiding blocklist vocabulary.
    """
    matches = []
    for pat, category in _INJECTION_PATTERNS:
        m = pat.search(text)
        if m:
            matches.append({
                "pattern": pat.pattern,
                "match": m.group(0),
                "category": category,
            })
    return matches


# Severity model. A structural match is a TAINT signal by default — treat the input
# as DATA, never as authority — not an automatic refusal. Only a real coordinated
# injection blocks: an override/constraint-removal DIRECTIVE combined with a harmful
# action (execution intent), OR two distinct high-severity directives together. Benign
# identity questions ("what model are you?"), role-play ("act as a reviewer"), quoted
# system text, security research, and lone analysis requests ("decode this base64")
# are ADMITTED-as-tainted, not blocked. (Pre-3.9 blocked on ANY structural match,
# which refused benign prompts and even broke the per-turn loop.)
_HIGH_DIRECTIVE = {"override_negation", "constraint_removal", "refusal_suppression", "emotional_authority", "cross_lingual"}
_MEDIUM_DIRECTIVE = {"role_hijack", "prompt_exfiltration", "instruction_injection", "hypothetical_framing", "prefix_injection", "payload_splitting"}
_EXEC_INTENT = {"obfuscation_execution"}


def analyze_input(text: str) -> dict:
    """Shared structural+severity analysis used by both screen() and detect(), so the
    two never disagree. Returns severity, categories, matches, taint and block flags."""
    raw = text or ""
    normalized = _normalize_text(raw)
    matches = detect_injection_patterns(normalized)
    decoded_hits = _decode_and_scan(raw)
    for dh in decoded_hits:
        if not any(m["match"] == dh["match"] for m in matches):
            matches.append(dh)
    cats = {m["category"] for m in matches}
    high = cats & _HIGH_DIRECTIVE
    has_exec = bool(cats & _EXEC_INTENT)
    # Block only a real coordinated injection: a directive to override/strip safeguards
    # combined with execution intent, or two distinct high-severity directives.
    block = bool(high) and (has_exec or len(high) >= 2 or (bool(cats & _MEDIUM_DIRECTIVE) and len(high) >= 1))
    if not block and len(cats) >= 3 and (high or has_exec):
        block = True
    severity = ("high" if block else
                "medium" if (high or has_exec or (bool(cats & _MEDIUM_DIRECTIVE) and len(cats) >= 2)) else
                "low" if matches else "none")
    return {"matches": matches, "categories": sorted(cats), "severity": severity,
            "tainted": bool(matches), "block_recommended": block}


# Ring types that legitimately NAME attack vocabulary or DESCRIBE a wound rather
# than being one — antibodies/faculties, recovery & quarantine records, epochs,
# dreams, conjectures, telemetry digests, operators, genesis. Both the full-chain
# detect() scan and the per-ring tripwire() must treat these as healthy tissue.
# ONE source so the two layers can never drift: pre-3.18 they had (detect() carried
# a shorter list), so `immune scan` false-flagged healthy conjecture/dream/epoch/
# genesis rings as "COMPROMISE DETECTED" that the tripwire correctly skipped.
_SKIP_RING_TYPES = ("recovery", "quarantine", "faculty", "faculty-recur",
                    "faculty-wake", "promotion", "epoch", "immune", "dream",
                    "telemetry-digest", "operator", "genesis", "conjecture")


class Immune:
    def __init__(self, root):
        self.tc = Timechain(root)
        self.state_path = self.tc.dir / "immune.json"
        self.lock_path = self.tc.dir / "LOCKED"
        self.floor = PoQGate().t["covenant_floor"]

    # ---- state ----
    def state(self):
        if self.state_path.exists():
            return json.loads(self.state_path.read_text())
        return {"locked": False, "safe_height": None, "quarantine": [], "scars": []}

    def _save(self, s):
        self.state_path.write_text(json.dumps(s, indent=2, ensure_ascii=False))

    def _summary(self, ring):
        p = ring.get("payload", {})
        return p.get("summary") or p.get("objective") or p.get("function") or json.dumps(p)[:200]

    # ---- detection ----
    def match_scar(self, text):
        t = set(tokens(text))
        for sc in self.state()["scars"]:
            v = set(sc.get("vector", []))
            if v and len(t & v) >= max(2, len(v) // 2):
                return sc
        return None

    def detect(self, input_text=None):
        s = self.state()
        q = set(s["quarantine"])
        signals, first_bad = [], None
        ok, _ = self.tc.verify()
        if not ok:
            signals.append("chain hash verification FAILED — tampering detected")
        # Only police the agent's own ASSERTIONS. Skip structural/capability rings:
        # faculties/antibodies legitimately *name* attack vocabulary; recovery/quarantine
        # rings describe the wound. Flagging those would be a false positive. Shared with
        # the tripwire via _SKIP_RING_TYPES so the two layers never disagree.
        for r in self.tc.load():
            if r["index"] == 0 or r["index"] in q or r["ring_type"] in _SKIP_RING_TYPES:
                continue
            summ = self._summary(r)
            reason, cats = self._wound_reason(summ, self._frame(r))
            if reason == "covenant":
                signals.append(f"ring {r['index']}: covenant breach sealed into memory")
                if first_bad is None:
                    first_bad = r["index"]
            elif reason == "structural":
                # v3.16: structural scan of sealed CONTENT, not just incoming input.
                signals.append(f"ring {r['index']}: coordinated structural injection "
                               f"sealed into memory {cats}")
                if first_bad is None:
                    first_bad = r["index"]
        incoming, structural, severity = None, [], "none"
        if input_text is not None:
            if score_covenant(input_text) < self.floor:
                incoming = "covenant-violating injection"
                signals.append("incoming input: covenant-violating injection")
            sc = self.match_scar(input_text)
            if sc:
                incoming = f"known scar {sc['id']}"
                signals.append(f"incoming input MATCHES known scar {sc['id']} ({sc['lesson']})")
            # Same structural analysis screen() uses, so scan and screen never disagree.
            # Only a COORDINATED injection is a compromise; lone taint is informational.
            a = analyze_input(input_text)
            structural = a["matches"]
            severity = a["severity"]
            if a["block_recommended"]:
                incoming = incoming or "structural injection (coordinated)"
                signals.append(f"incoming input: coordinated structural injection {a['categories']}")
        return {"compromised": bool(signals), "signals": signals,
                "first_bad_height": first_bad, "incoming": incoming,
                "structural": structural,
                "structural_severity": severity if input_text is not None else "none"}

    def screen(self, input_text):
        """Pre-seal intake check. Block at the membrane only for a real threat:
          1. Covenant blocklist (score_covenant < floor) — keyword-based covenant breach
          2. Scar matching — known attack-vector signatures
          3. A coordinated STRUCTURAL injection (analyze_input.block_recommended) —
             override/constraint-removal directive + execution intent, or two such
             directives. A lone structural match is admitted-as-TAINTED, not blocked.
        Always returns the structural matches + severity for forensics, even when
        admitted, so a refusal (or a taint) can say exactly what triggered it."""
        cov = score_covenant(input_text)
        sc = self.match_scar(input_text)
        a = analyze_input(input_text)
        blocked = cov < self.floor or sc is not None or a["block_recommended"]
        reason = ("covenant" if cov < self.floor else
                  "scar" if sc is not None else
                  "structural_injection" if a["block_recommended"] else None)
        return {
            "blocked": blocked,
            "reason": reason,
            "covenant": cov,
            "scar": sc,
            "structural": a["matches"],
            "categories": a["categories"],
            "severity": a["severity"],
            "tainted": a["tainted"],
        }

    # ---- post-seal tripwire (v3.16: catch & quarantine WHEN it happens) ----
    # Skip set shared with detect() via the module-level _SKIP_RING_TYPES so the
    # membrane's two layers can never disagree about what is healthy tissue.
    def _wound_reason(self, summ, frame=None):
        """The SINGLE use/mention + frame-aware wound judgment for a SEALED ring (the
        agent's OWN assertion). detect(), tripwire() and _ring_is_wound() all reason
        from this one predicate so they can never disagree. Returns (reason, categories):
          ("covenant", None)        — a first-person or bare-use covenant breach
          ("structural", [cats])    — a coordinated structural injection (de-quoted)
          (None, None)              — healthy tissue (mention/quotation/clean)
        *frame* is the ring's DECLARED provenance (topological): 'mention' exempts NAMING
        the vocabulary, but the intent backstop inside covenant_breach still fires — a
        declared mention can never launder first-person intent. De-quoting is applied
        ONLY here, to the agent's own sealed content — incoming input is judged
        adversarially by screen()/detect()-input, never through this predicate."""
        if covenant_breach(summ, self.floor, frame):   # frame-aware; intent overrides mention
            return ("covenant", None)
        if frame == "mention" or mention_frame(summ):
            return (None, None)                        # analyst stance, no breach
        a = analyze_input(strip_quoted_spans(summ))
        if a["block_recommended"]:
            return ("structural", a["categories"])
        return (None, None)

    def _frame(self, ring):
        """The ring's declared content provenance ('assertion' | 'mention' | 'input'),
        or None when it did not declare one (fall back to lexical inference)."""
        return (ring.get("payload") or {}).get("frame")

    def _ring_is_wound(self, ring) -> bool:
        """True when a SEALED ring is itself a compromise. Skip-type capability rings
        are healthy tissue by construction; everything else defers to _wound_reason."""
        if ring.get("index") == 0 or ring.get("ring_type", "") in _SKIP_RING_TYPES:
            return False
        return self._wound_reason(self._summary(ring), self._frame(ring))[0] is not None

    def _wound_floor(self, rings, ring_index):
        """Earliest index of the CONTIGUOUS wound block ending at *ring_index*. Walk
        backward while rings stay compromised, stopping at the first clean / skip /
        mention / already-quarantined ring. Bounded by design: the auto-heal can
        heal a multi-ring wound (e.g. seals that bypassed the reflex) without ever
        reaching an unrelated older flag and nuking healthy history."""
        q = set(self.state()["quarantine"])
        by_idx = {r["index"]: r for r in rings}
        floor = ring_index
        i = ring_index - 1
        while i >= 1:
            r = by_idx.get(i)
            if r is None or i in q or not self._ring_is_wound(r):
                break
            floor = i
            i -= 1
        return floor

    def tripwire(self, ring, input_text=None):
        """Judge a SINGLE just-sealed ring for compromise. This is the second layer:
        the input screen (screen()) polices the ATTEMPT before reasoning; the tripwire
        polices the OUTCOME — what actually got sealed into memory — which is the true
        compromise signal. It fires only on a real wound (a covenant breach or a
        coordinated structural injection sealed into the agent's OWN assertion, or a
        chain that no longer verifies), never on merely-tainted input the agent
        correctly handled. Returns {compromised, reason, first_bad, ...}."""
        summ = self._summary(ring)
        rtype = ring.get("ring_type", "")
        # Structural / capability rings are healthy tissue by construction; everything
        # else defers to the shared use/mention-aware predicate.
        if rtype in _SKIP_RING_TYPES:
            return {"compromised": False, "reason": None, "first_bad": None,
                    "ring": ring["index"]}
        reason, cats = self._wound_reason(summ, self._frame(ring))
        if reason == "covenant":
            return {"compromised": True, "reason": "covenant_breach_sealed",
                    "first_bad": ring["index"], "covenant": score_covenant(summ),
                    "ring": ring["index"]}
        if reason == "structural":
            return {"compromised": True, "reason": "structural_injection_sealed",
                    "first_bad": ring["index"], "categories": cats,
                    "ring": ring["index"]}
        return {"compromised": False, "reason": None, "first_bad": None,
                "ring": ring["index"], "input_tainted": bool(input_text and analyze_input(input_text)["tainted"])}

    def auto_guard(self, ring_index, input_text=None, lesson=None, difficulty=0):
        """The self-healing reflex: run the tripwire on the just-sealed ring and, if it
        is a genuine wound, AUTONOMOUSLY lock down and roll the chain back to the block
        BEFORE it — molting the wound into a scar and growing an antibody — so a
        compromise is quarantined the moment it happens, not on a later manual scan.
        Fail-open: any error returns action='error' and takes NO destructive action."""
        try:
            rings = self.tc.load()
            ring = next((r for r in rings if r["index"] == ring_index), None)
            if ring is None:
                return {"action": "none", "reason": "ring_not_found"}
            # Whole-chain integrity: a failed verify means tampering somewhere; that is
            # a lockdown-and-alert condition (we cannot know the true first_bad from one
            # ring), never a blind auto-rollback.
            ok, _ = self.tc.verify()
            if not ok:
                self.lockdown()
                return {"action": "lockdown", "reason": "chain_verify_failed",
                        "note": "chain no longer verifies — locked; run immune.scan + human review before rollback."}
            tw = self.tripwire(ring, input_text=input_text)
            if not tw["compromised"]:
                return {"action": "none", "reason": tw.get("reason"),
                        "input_tainted": tw.get("input_tainted", False)}
            self.lockdown()
            # Heal the WHOLE contiguous wound, not just the last ring: if an earlier
            # ring was sealed compromised without the reflex running (reflex off, a
            # manual seal, a subagent path, or a prior fail-open), rolling back only
            # to ring_index-1 would leave that wound ACTIVE. The floor walk quarantines
            # the full block while staying bounded to it.
            floor = self._wound_floor(rings, tw["first_bad"])
            rep = self.rollback(floor,
                                lesson=lesson or f"auto-quarantine: {tw['reason']}",
                                difficulty=difficulty)
            rep["action"] = "rolled_back"
            rep["reason"] = tw["reason"]
            # Surface — never blindly auto-nuke — any OLDER, non-contiguous wound left
            # in the record, so the human can `immune scan` rather than the reflex
            # reaching back across healthy history.
            resid = self.detect()
            if resid["compromised"] and resid["first_bad_height"] is not None:
                rep["residual_compromise"] = resid["first_bad_height"]
            return rep
        except Exception as exc:                       # fail-open: never brick the turn
            return {"action": "error", "error": str(exc)}

    # ---- response ----
    def lockdown(self):
        s = self.state()
        s["locked"] = True
        self._save(s)
        self.lock_path.write_text("immune lockdown — recover before sealing\n")
        return s

    def rollback(self, first_bad_height, lesson="prompt-injection / jailbreak",
                 difficulty=0, grow_antibody=True):
        rings = self.tc.load()
        head = rings[-1]["index"]
        if first_bad_height < 1 or first_bad_height > head:
            raise ValueError("first_bad_height out of range")
        safe = first_bad_height - 1
        quarantined = list(range(first_bad_height, head + 1))
        vec = []
        for r in rings:
            if r["index"] in quarantined:
                vec += tokens(self._summary(r))
        vector = [w for w, _ in Counter(vec).most_common(8)]
        safe_ring = next(r for r in rings if r["index"] == safe)
        s = self.state()
        scar = {"id": f"scar{len(s['scars']) + 1}", "vector": vector,
                "blocks": quarantined, "lesson": lesson}
        payload = {"event": "recovery", "resumed_from_height": safe,
                   "resumed_from_hash": safe_ring["ring_hash"], "quarantined": quarantined,
                   "scar": scar,
                   "summary": (f"Immune recovery: rolled back to clean height {safe}; "
                               f"quarantined {quarantined} as {scar['id']} (molted scar).")}
        # 'recovery' ring is permitted even under lockdown
        ring = self.tc.seal("recovery", payload, difficulty=difficulty)
        s["safe_height"] = safe
        s["quarantine"] = sorted(set(s["quarantine"]) | set(quarantined))
        s["scars"].append(scar)
        s["locked"] = False                       # returned to clean state
        self._save(s)
        if self.lock_path.exists():
            self.lock_path.unlink()                # MUST unlock before growing (faculty seal is gated)

        # Molt -> immunity: grow an antibody Sense from the scar's attack vector (Cambium).
        antibody = None
        if grow_antibody and vector:
            try:
                import cambium
                res, fring = cambium.grow(self.tc.root, " ".join(vector),
                                          context=f"immune antibody from {scar['id']} ({lesson})",
                                          kind_override="sense", difficulty=difficulty)
                if res.get("grew"):
                    fac = res["faculty"]
                    antibody = {"name": fac["name"], "eid": fac.get("eid"),
                                "ring": fring["index"] if fring else None}
                else:
                    antibody = {"skipped": "gap below growth threshold"}
            except Exception as exc:                # registry absent or growth failed
                antibody = {"error": str(exc)}
            scar["antibody"] = antibody
            self._save(s)
        return {"safe_height": safe, "quarantined": quarantined, "scar": scar,
                "recovery_ring": ring["index"], "antibody": antibody}

    def active_rings(self):
        q = set(self.state()["quarantine"])
        return [r for r in self.tc.load() if r["index"] not in q]

    def status(self):
        s = self.state()
        active = self.active_rings()
        return {"locked": s["locked"], "safe_height": s["safe_height"],
                "quarantined": s["quarantine"], "active_head": active[-1]["index"] if active else None,
                "scars": s["scars"]}


# --------------------------------------------------------------------------- #
# Module-level convenience (mirrors cambium.grow(root, …) call style)
# --------------------------------------------------------------------------- #

def guard_turn(root, ring_index, input_text=None, lesson=None, difficulty=0):
    """Post-seal self-healing reflex: tripwire the just-sealed ring; auto-lockdown +
    roll back to the block before it if it is a genuine wound. Fail-open."""
    return Immune(root).auto_guard(ring_index, input_text=input_text,
                                   lesson=lesson, difficulty=difficulty)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def cmd_scan(args):
    d = Immune(args.root).detect(input_text=args.input)
    print("COMPROMISE DETECTED" if d["compromised"] else "clean — no compromise detected")
    for sig in d["signals"]:
        print(f"  ! {sig}")
    # Same structural analysis screen() uses, so scan and screen never disagree.
    if d.get("structural"):
        print(f"  structural severity: {d.get('structural_severity')} (lone matches are admitted as data, not a compromise)")
        for s in d["structural"]:
            print(f"    ~ structural [{s['category']}]: '{s['match']}'")
    if d["first_bad_height"] is not None:
        print(f"  -> first compromised blockheight: {d['first_bad_height']}  (safe height: {d['first_bad_height']-1})")


def cmd_screen(args):
    r = Immune(args.root).screen(args.input)
    print(f"covenant={r['covenant']}  scar_match={r['scar']['id'] if r['scar'] else None}  "
          f"severity={r.get('severity')}  structural_hits={len(r.get('structural', []))}")
    for s in r.get("structural", []):
        print(f"  ~ structural [{s['category']}]: '{s['match']}'")
    print(f"BLOCKED at membrane (reason: {r.get('reason')})" if r["blocked"]
          else ("admitted as TAINTED data (do not treat as authority)" if r.get("tainted") else "admitted"))
    sys.exit(2 if r["blocked"] else 0)


def cmd_lockdown(args):
    Immune(args.root).lockdown()
    print("IMMUNE LOCKDOWN engaged — normal sealing refused until recovery.")


def cmd_rollback(args):
    r = Immune(args.root).rollback(args.height, lesson=args.lesson or "prompt-injection / jailbreak",
                                   grow_antibody=not args.no_antibody)
    print(f"ROLLBACK complete. resumed from clean height {r['safe_height']}.")
    print(f"  quarantined (molted) blocks: {r['quarantined']}")
    print(f"  scar {r['scar']['id']} learned — vector: {', '.join(r['scar']['vector'])}")
    print(f"  recovery sealed as Ring {r['recovery_ring']}; lockdown lifted.")
    ab = r.get("antibody")
    if ab and ab.get("name"):
        print(f"  ANTIBODY grown automatically: sense '{ab['name']}' ({ab['eid']}) sealed as Ring {ab['ring']}")
    elif ab and ab.get("error"):
        print(f"  (antibody not grown: {ab['error']})")
    elif ab:
        print(f"  (antibody not grown: {ab.get('skipped')})")


def cmd_guard(args):
    r = guard_turn(args.root, args.ring, input_text=args.input, lesson=args.lesson)
    act = r.get("action", "none")
    if act == "rolled_back":
        print(f"AUTO-QUARANTINE FIRED ({r.get('reason')}): rolled back to clean height "
              f"{r['safe_height']}; molted blocks {r['quarantined']} as {r['scar']['id']}.")
        print(f"  recovery sealed as Ring {r['recovery_ring']}; lockdown lifted.")
        ab = r.get("antibody")
        if ab and ab.get("name"):
            print(f"  antibody grown: sense '{ab['name']}' ({ab['eid']}) Ring {ab['ring']}")
        if r.get("residual_compromise") is not None:
            print(f"  ! residual older wound remains at height {r['residual_compromise']} "
                  f"(non-contiguous) — run `immune scan` for full review.")
    elif act == "lockdown":
        print(f"LOCKDOWN ({r.get('reason')}): {r.get('note')}")
    elif act == "error":
        print(f"guard error (fail-open, no action taken): {r.get('error')}")
    else:
        print(f"clean — no wound sealed (input_tainted={r.get('input_tainted', False)}).")


def cmd_status(args):
    st = Immune(args.root).status()
    print(f"locked: {st['locked']}   safe_height: {st['safe_height']}   active_head: {st['active_head']}")
    print(f"quarantined (scars in record, excluded from active self): {st['quarantined']}")
    for sc in st["scars"]:
        print(f"  scar {sc['id']}: blocks {sc['blocks']} | lesson: {sc['lesson']} | vector: {', '.join(sc['vector'][:6])}")


def build_parser():
    default_root = Path(__file__).resolve().parent
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", type=Path, default=default_root)
    p = argparse.ArgumentParser(description="Immune — detect compromise, lock down, roll back to a clean blockheight, molt scars.")
    sub = p.add_subparsers(dest="cmd", required=True)

    ps = sub.add_parser("scan", parents=[common], help="detect compromise in sealed memory (and optional input)")
    ps.add_argument("--input", default=None)
    ps.set_defaults(func=cmd_scan)

    pscr = sub.add_parser("screen", parents=[common], help="pre-seal intake check of an incoming input")
    pscr.add_argument("--input", required=True)
    pscr.set_defaults(func=cmd_screen)

    pl = sub.add_parser("lockdown", parents=[common], help="freeze sealing until recovery")
    pl.set_defaults(func=cmd_lockdown)

    pr = sub.add_parser("rollback", parents=[common], help="roll back to the clean height before compromise; molt scar")
    pr.add_argument("--height", type=int, required=True, help="first compromised blockheight")
    pr.add_argument("--lesson", default=None)
    pr.add_argument("--no-antibody", action="store_true", help="skip auto-growing the antibody sense")
    pr.set_defaults(func=cmd_rollback)

    pg = sub.add_parser("guard", parents=[common], help="post-seal tripwire: auto-lockdown + rollback to the block before a sealed wound")
    pg.add_argument("--ring", type=int, required=True, help="index of the just-sealed ring to judge")
    pg.add_argument("--input", default=None, help="the input that produced the ring (for taint forensics)")
    pg.add_argument("--lesson", default=None)
    pg.set_defaults(func=cmd_guard)

    pst = sub.add_parser("status", parents=[common], help="immune status: lockdown, safe height, quarantine, scars")
    pst.set_defaults(func=cmd_status)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
