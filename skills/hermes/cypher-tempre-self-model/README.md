# Cypher Tempre Timechain Self-Model

**Runtime label:** Hermes skill version.

This is the Hermes bundle for Cypher Tempre: a persistent, verifiable,
self-healing cognitive self-model for an AI agent. It is stdlib-only Python,
uses Hermes-discoverable frontmatter, and ships without generated memory state.

## Install

Copy this folder into Hermes's configured skills directory:

```bash
cp -R cypher-tempre-self-model /path/to/hermes/skills/
```

Refresh Hermes's skill list, then initialize a fresh chain inside the copied
bundle:

```bash
python3 timechain.py init --name Hermes
python3 timechain.py verify
```

## Hermes Enforcement

Hermes does not currently provide Claude/Codex-style lifecycle shell hooks that
can block a response at `Stop`. The bundled `loop_hook.sh`, `stop_hook.sh`,
`subagent_stop_hook.sh`, and `session_start_hook.sh` are kept for hook-capable
runtimes and for source parity, but Hermes does not auto-run them.

Hermes agents self-enforce the same discipline:

```bash
python3 enforce.py mark
python3 recall.py turn "<finding or decision>" --input "<user request>"
python3 enforce.py stop-check
```

If `stop-check` prints a JSON object with `"decision":"block"`, seal a ring
before returning. If it prints nothing, the marked turn sealed successfully.
For custom task chains, pass the same `--root <chain>` to `enforce.py` and
`recall.py`, or set `CT_ENFORCE_ROOT=<chain>`.

For delegated Hermes work, use `hermes/cypher-tempre-agent.md`. An optional
terminal/cron helper is available at `hermes/enforcement-watchdog.sh`.

See `SKILL.md` for the full per-turn protocol.


## Enforcement troubleshooting

Every bundle exposes the same enforcement status. Hook-enabled session/prompt context
contains its compact form; blocked Stop feedback includes the exact cause, turn id,
enforced root, baseline/current heads, delta, and nudge count. Healthy Stop checks
remain silent by contract.

```bash
python3 enforce.py status
python3 enforce.py status --line
python3 enforce.py status --json
```

These commands are read-only: they do not seal, append telemetry, or change adherence.

## Data retention & third-party transmission

This skill is a **persistent memory system**. By design it records each turn — your
request and the agent's decision — into an append-only, hash-chained ledger under
`chain/` that is **never deleted** (history is immutable; that tamper-evidence is the
point). Treat it like a local journal:

- **Everything is stored locally, in cleartext.** Do not feed it secrets, credentials,
  or PII you would not want retained indefinitely. The chain is tamper-EVIDENT, not
  encrypted, and there is no built-in redaction or expiry.
- **It stays on your machine by default.** The core engine is stdlib-only and the
  default embedder is local; nothing is transmitted off-machine.
- **Optional embedding providers send text to a third party.** If you explicitly enable
  the OpenAI / Voyage / sentence-transformers backends (they need an API key or extra
  library and are OFF by default), the text being embedded — which may include memory
  chunks, source excerpts, or other chain contents — is sent to that provider. Keep the
  default local `hashing` embedder if that is a concern.
