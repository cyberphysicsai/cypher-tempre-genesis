# Cypher Tempre Timechain Self-Model

**Runtime label:** OpenClaw skill version.

This is the OpenClaw bundle for Cypher Tempre: a persistent, verifiable,
self-healing cognitive self-model for an AI agent. It is stdlib-only Python,
uses OpenClaw-compatible frontmatter, and ships without generated memory state.

## Install

Copy this folder into OpenClaw's workspace skills directory:

```bash
cp -R cypher-tempre-self-model ~/.openclaw/workspace/skills/
```

Refresh OpenClaw's skill list, then initialize a fresh chain inside the copied
bundle:

```bash
python3 timechain.py init --name OpenClaw
python3 timechain.py verify
```

## OpenClaw Enforcement

The strongest OpenClaw path is the native plugin included in this bundle. It
uses typed OpenClaw plugin hooks: `before_prompt_build` marks the turn, and
`before_agent_finalize` requests one more model pass if `enforce.py stop-check`
finds that no ring was sealed.

```bash
openclaw plugins install ~/.openclaw/workspace/skills/cypher-tempre-self-model/openclaw-plugin
openclaw config set 'plugins.entries.cypher-tempre-enforcement.hooks.allowConversationAccess' true --strict-json
openclaw gateway restart
```

For non-bundled local installs, the config command above is required so OpenClaw
allows the `before_agent_finalize` Stop-equivalent hook. Equivalent JSON in
`~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "cypher-tempre-enforcement": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

If your skill is not installed at
`~/.openclaw/workspace/skills/cypher-tempre-self-model`, set
`plugins.entries.cypher-tempre-enforcement.config.skillRoot` to the installed
skill folder:

```bash
openclaw config set 'plugins.entries.cypher-tempre-enforcement.config.skillRoot' /path/to/cypher-tempre-self-model
openclaw gateway restart
```

See `openclaw-plugin/README.md`.

Fallback for runtimes where plugins are unavailable:

```bash
python3 enforce.py mark
python3 recall.py turn "<finding or decision>" --input "<user request>"
python3 enforce.py stop-check
```

If `stop-check` prints a JSON object with `"decision":"block"`, seal a ring
before returning. If it prints nothing, the marked turn sealed successfully.
For custom task chains, pass the same `--root <chain>` to `enforce.py` and
`recall.py`, or set `CT_ENFORCE_ROOT=<chain>`.

For delegated OpenClaw work, use `openclaw/cypher-tempre-agent.md` or
`agents/cypher-tempre-agent.md`. An optional terminal/cron helper is available
at `openclaw/enforcement-watchdog.sh`.

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
