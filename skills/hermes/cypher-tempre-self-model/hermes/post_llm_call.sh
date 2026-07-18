#!/bin/bash
# Cypher Tempre — Hermes post_llm_call hook (the Stop-hook equivalent, adapted).
#
# Hermes fires post_llm_call ONCE per turn, AFTER the tool loop produced a final
# response, and IGNORES the return value (agent/shell_hooks.py never reads a Stop
# decision here). So — unlike Claude Code's Stop hook — this CANNOT hard-block a
# turn from ending. Instead enforce.py 'hermes-post' RECORDS seal debt when a turn
# ended without sealing a ring (or advancing an open audit). That debt is the
# closed-loop feedback the NEXT pre_llm_call escalates from advisory reminder to a
# structured SEAL-DEBT demand (seal, or explicitly waive-with-reason via
# `enforce.py waive`). Because Hermes fires this exactly once per turn, there is no
# nudge budget here: one unsealed turn = one unit of debt, recorded immediately.
# Over a session this converges on 100% adherence and never bricks a turn.
# Fail-open: exit 0 always. CT_ENFORCE_DEBUG=1 surfaces enforce.py stderr.
SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SKILL/enforce.py" ] || exit 0
case "${CT_ENFORCE_DEBUG:-}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On|debug|DEBUG|Debug)
  python3 "$SKILL/enforce.py" hermes-post
  ;;
  *)
  python3 "$SKILL/enforce.py" hermes-post 2>/dev/null
  ;;
esac
exit 0
