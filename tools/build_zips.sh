#!/usr/bin/env bash
# Rebuild the drag-and-drop skill zips in downloads/ from the CURRENT source
# bundles. These files are the SINGLE source of truth for BOTH distribution
# channels:
#   - downloads/                (raw-main drag-and-drop, linked from README.md)
#   - the GitHub release assets  (upload these SAME files — never build a second set)
#
# Run this on EVERY release so the two channels can never drift (the bug that
# forced v3.3.3: stale v3.3.1 zips lingering in downloads/ while the release was
# already newer). Zips are state-free: chain/, tasks/, caches, and the audit
# pointer are excluded.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(cat "$ROOT/skills/claude/cypher-tempre-self-model/VERSION")"
SMOL_VERSION="$(cat "$ROOT/skills/smol-lm/cypher-tempre-smol-lm/VERSION")"
DEST="$ROOT/downloads"
mkdir -p "$DEST"
MODE="${1:---all}"
if [[ "$MODE" != "--all" && "$MODE" != "--smol-only" ]]; then
  echo "usage: bash tools/build_zips.sh [--all|--smol-only]" >&2
  exit 2
fi

# Drop stale skill zips of ANY version so old packages never linger. (Leaves the
# dashboard/static-site zips, which use the 'cyphertempre-' prefix, untouched.)
if [[ "$MODE" == "--all" ]]; then
  rm -f "$DEST"/cypher-tempre-*-skill-v*.zip
else
  rm -f "$DEST"/cypher-tempre-smol-lm-skill-v*.zip
fi

# Package git-TRACKED files plus the explicit state-free runtime source allowlist below,
# never a directory walk. This makes
# a per-user state leak structurally impossible: a lived-in dev install can have learner
# state (registry/policy.json, scorer.json, labeler.json, lens/, grown*.json, emergent.json,
# chain/, tasks/) on disk, all gitignored — and since none of it is tracked, none of it can
# ever ship. (Pre-3.9 zipped the working dir with an exclusion list that omitted the
# learner-state paths .gitignore says must never ship.) An assert below double-checks.
MUSTNOT='registry/(policy|scorer|labeler|grown|grown_ops|emergent)\.json|registry/lens/|/chain/|/tasks/|\.pyc$|__pycache__|\.active_audit|\.DS_Store'
RUNTIME_SOURCE_ALLOWLIST=(cypher-tempre-self-model/registry_store.py)
if [[ "$MODE" == "--all" ]]; then
  for r in claude codex hermes nanoclaw openclaw; do
    zipf="$DEST/cypher-tempre-$r-skill-v$VERSION.zip"
    for rel in "${RUNTIME_SOURCE_ALLOWLIST[@]}"; do
      if [[ ! -f "$ROOT/skills/$r/$rel" ]]; then
        echo "FATAL: missing runtime packet file: skills/$r/$rel" >&2
        exit 1
      fi
    done
    ( cd "$ROOT/skills/$r"
      {
        git -C "$ROOT" ls-files "skills/$r/cypher-tempre-self-model" | sed "s#^skills/$r/##"
        printf '%s\n' "${RUNTIME_SOURCE_ALLOWLIST[@]}"
      } | sort -u | zip -q "$zipf" -@
    )
    leak="$(unzip -Z1 "$zipf" | grep -E "$MUSTNOT" || true)"
    if [ -n "$leak" ]; then
      echo "FATAL: $zipf would ship gitignored state:" >&2; echo "$leak" >&2; exit 1
    fi
    echo "built downloads/cypher-tempre-$r-skill-v$VERSION.zip (tracked + explicit source allowlist; leak-checked)"
  done
fi

# The experimental Smol LM packet is intentionally small and independent from the
# five runtime copies. Package a fixed allowlist so a working-tree build can include
# a brand-new packet without weakening the tracked-only state-leak guarantee above.
SMOL_FILES=(
  cypher-tempre-smol-lm/SKILL.md
  cypher-tempre-smol-lm/VERSION
  cypher-tempre-smol-lm/LICENSE
  cypher-tempre-smol-lm/agents/openai.yaml
  cypher-tempre-smol-lm/references/controller-contract.md
  cypher-tempre-smol-lm/scripts/strict_turn.py
)
for rel in "${SMOL_FILES[@]}"; do
  if [[ ! -f "$ROOT/skills/smol-lm/$rel" ]]; then
    echo "FATAL: missing Smol LM packet file: skills/smol-lm/$rel" >&2
    exit 1
  fi
done
smol_zip="$DEST/cypher-tempre-smol-lm-skill-v$SMOL_VERSION.zip"
( cd "$ROOT/skills/smol-lm" && printf '%s\n' "${SMOL_FILES[@]}" | zip -q "$smol_zip" -@ )
leak="$(unzip -Z1 "$smol_zip" | grep -E "$MUSTNOT" || true)"
if [ -n "$leak" ]; then
  echo "FATAL: $smol_zip would ship runtime state:" >&2; echo "$leak" >&2; exit 1
fi
echo "built downloads/cypher-tempre-smol-lm-skill-v$SMOL_VERSION.zip (fixed allowlist; leak-checked)"

echo
echo "downloads/ rebuilt (runtime v$VERSION; Smol LM v$SMOL_VERSION)."
echo "Upload the SAME runtime files to the runtime release:"
echo "  gh release create v$VERSION $DEST/cypher-tempre-{claude,codex,hermes,nanoclaw,openclaw}-skill-v$VERSION.zip \\"
echo "    --title \"v$VERSION — ...\" --notes \"...\""
echo "The Smol LM packet remains an independently versioned experimental asset:"
echo "  $smol_zip"
