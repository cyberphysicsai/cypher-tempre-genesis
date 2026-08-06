# Skills Directory

This directory contains five labeled, self-contained Cypher Tempre runtime skill
variants plus one separately versioned experimental controller skill. Each runtime
variant includes the same reusable stdlib Python helpers and registries, plus a
runtime-specific `SKILL.md`.

| Runtime label | Path | Notes |
|---|---|---|
| Claude skill version | `claude/cypher-tempre-self-model/` | Claude Code compatible `SKILL.md` bundle. |
| Codex skill version | `codex/cypher-tempre-self-model/` | Codex compatible bundle with `agents/openai.yaml` metadata plus Codex lifecycle hook installer/template. |
| OpenClaw skill version | `openclaw/cypher-tempre-self-model/` | OpenClaw compatible bundle with OpenClaw frontmatter, `.clawhubignore`, native plugin enforcement, and self-enforcement fallback. |
| Hermes skill version | `hermes/cypher-tempre-self-model/` | Hermes-discoverable bundle with explicit mark/seal/stop-check self-enforcement plus Hermes subagent notes. |
| NanoClaw skill version | `nanoclaw/cypher-tempre-self-model/` | NanoClaw-discoverable bundle copied from the OpenClaw implementation. |
| Smol LM Version | `smol-lm/cypher-tempre-smol-lm/` | Compact model contract and strict receipt/release controller; depends on an installed runtime engine. |

## Shared file set

Each runtime bundle labels its files through the path prefix above and contains:

- `SKILL.md` - runtime-specific skill instructions.
- `README.md` - runtime-specific human overview and install note.
- `VERSION`, `LICENSE`, `CHANGELOG.md` - package metadata.
- `openclaw-plugin/` - native OpenClaw plugin package in the OpenClaw bundle.
- `timechain.py`, `task.py`, `poq.py`, `cambium.py`, `chronosynaptic.py`, `continuum.py`, `audit.py`, `recall.py`, `embed.py`, `consensus.py`, `immune.py`, `dormancy.py`, `telemetry.py` - reusable stdlib helpers. (The test suite is not shipped; it lives at `tests/selftest.py` in the repository.)
- `registry/modalities.json`, `registry/senses.json` - base faculty registries for fresh installs.

Generated `chain/`, `tasks/`, `registry/emergent.json`, `registry/grown.json`, and
`registry/grown_ops.json` are ignored so shared bundles do not ship someone else's
memory ledger or learned faculties.

## Codebase cartography hardening

The shared `continuum.py` and `recall.py` helpers support long-horizon code audits
without pretending to create infinite context. Continuum stores source coordinates,
file/chunk hashes, path roles, branch metadata, redaction state, and task progress.
Recall can filter by path, role, language, extension, and neighbors, then
`verify-source` checks a retrieved ring against the live repo before an agent trusts it.
