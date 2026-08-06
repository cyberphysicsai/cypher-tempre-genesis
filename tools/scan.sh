#!/usr/bin/env bash
# Scan the shipped skill bundles with SkillSpector.
#
# The BUNDLE — not the repo root — is the canonical scan target: a bundle is
# exactly what installs. A repo-root scan intentionally reads files that never
# ship (the test suite and its fixtures, the release/build scripts, the pre-built
# downloads/ zips, the dashboard/site docs), so it scores high by design. Point
# the scanner at a bundle to assess what actually runs.
#
# Usage:
#   bash tools/scan.sh           # static scan of all shipped skill packets (fast)
#   bash tools/scan.sh --llm     # include the model-assisted analysis pass
#
# Override the scanner binary with SKILLSPECTOR=/path/to/skillspector.

cd "$(dirname "$0")/.." || exit 1

SKILLSPECTOR="${SKILLSPECTOR:-skillspector}"
LLM_FLAG="--no-llm"
[ "${1:-}" = "--llm" ] && LLM_FLAG=""

rc=0
for r in claude codex hermes nanoclaw openclaw; do
    echo "=== scanning ${r} bundle ==="
    "$SKILLSPECTOR" scan "skills/${r}/cypher-tempre-self-model" $LLM_FLAG || rc=$?
done
echo "=== scanning Smol LM Version packet ==="
"$SKILLSPECTOR" scan "skills/smol-lm/cypher-tempre-smol-lm" $LLM_FLAG || rc=$?
exit "$rc"
