#!/bin/bash
# Cypher Tempre — Hermes pre_llm_call hook (the UserPromptSubmit + SessionStart equivalent).
#
# Hermes fires pre_llm_call ONCE per turn, BEFORE the tool loop, and — uniquely
# among Hermes hooks — USES the return value to inject context into the turn
# (agent/shell_hooks.py:_parse_response reads a top-level {"context": "..."}).
# enforce.py 'hermes-pre':
#   * marks turn-start (head index + audit cursor snapshot, resets the nudge budget),
#   * injects the per-turn loop reminder as context,
#   * on the FIRST turn also primes the session (verify/health/covenant) — Hermes'
#     on_session_start hook return is IGNORED, so priming must ride here,
#   * escalates to a structured SEAL-DEBT demand if a prior turn ended unsealed.
#
# enforce.py emits a UNION envelope ({"context": ...} for Hermes PLUS the Claude
# 'hookSpecificOutput' shape) so the identical output is honoured on every harness.
# Fail-open: exit 0 always. CT_ENFORCE_DEBUG=1 surfaces enforce.py stderr for diagnosis.
SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SKILL/enforce.py" ] || exit 0
case "${CT_ENFORCE_DEBUG:-}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On|debug|DEBUG|Debug)
  python3 "$SKILL/enforce.py" hermes-pre
  ;;
  *)
  python3 "$SKILL/enforce.py" hermes-pre 2>/dev/null
  ;;
esac
exit 0
