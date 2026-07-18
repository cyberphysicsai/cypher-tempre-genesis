#!/bin/bash
# Cypher Tempre — Hermes subagent_stop hook (the SubagentStop equivalent, adapted).
#
# Hermes fires subagent_stop ONCE per child agent after delegate_task finishes, and
# IGNORES the return value (it cannot block a child's return). So this OBSERVES:
# enforce.py 'hermes-subagent' records whether the delegating turn's identity chain
# (or an open audit chain) advanced, i.e. whether spawned work left a sealed trace.
# A subagent that forged its OWN task chain should seal to it (set CT_ENFORCE_ROOT
# in the child's environment); by default we account against the identity chain the
# parent shares. Firing is marshalled to the parent thread by Hermes, so this runs
# serially even under heavy fan-out. Fail-open: exit 0 always.
SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SKILL/enforce.py" ] || exit 0
case "${CT_ENFORCE_DEBUG:-}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On|debug|DEBUG|Debug)
  python3 "$SKILL/enforce.py" hermes-subagent
  ;;
  *)
  python3 "$SKILL/enforce.py" hermes-subagent 2>/dev/null
  ;;
esac
exit 0
