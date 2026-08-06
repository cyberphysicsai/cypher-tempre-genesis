# Cypher Tempre Timechain Self-Model

**Runtime label:** Codex skill version.

This is the Codex bundle for Cypher Tempre: a persistent, verifiable,
self-healing cognitive self-model for an AI agent. It is stdlib-only Python,
includes `agents/openai.yaml` UI metadata, and ships without generated memory
state.

## Install

Copy this folder into your Codex skills directory:

```bash
cp -R cypher-tempre-self-model ~/.codex/skills/
```

Restart or refresh Codex so the skill list updates. Initialize a fresh chain
inside the copied bundle:

```bash
python3 timechain.py init --name Codex
python3 timechain.py verify
```

Enable Codex lifecycle hooks for the installed skill:

```bash
python3 install_codex_hooks.py
```

The installer merges `SessionStart`, `UserPromptSubmit`, `Stop`, and
`SubagentStop` hook entries into `~/.codex/hooks.json` using absolute paths to
this skill folder. It preserves unrelated hooks and writes a backup before
replacing an existing file. Open `/hooks` in Codex to review and trust the new
command hooks, then restart or start a new session.

### Codex CLI hook checklist

The app and CLI use the same hook scripts, but they can differ in **activation
state**: the app may already have the hooks installed and trusted, while a fresh
CLI install only has the skill folder. For the CLI, the lifecycle hooks must be
present in `~/.codex/hooks.json` and trusted by Codex before Stop/SubagentStop can
block reliably.

If the CLI reports a Stop hook or invalid JSON issue:

```bash
cd ~/.codex/skills/cypher-tempre-self-model
python3 timechain.py verify
python3 install_codex_hooks.py
```

Then run `codex`, open `/hooks`, trust the four Cypher Tempre hooks, and restart
the CLI session. For one-off automation only, Codex also exposes
`--dangerously-bypass-hook-trust`, but normal users should trust the hooks through
`/hooks` instead.

The hook stdout contract is strict:

- `SessionStart` and `UserPromptSubmit` emit hook-JSON context envelopes.
- `Stop` and `SubagentStop` emit either exactly `{"decision":"block",...}` or
  nothing.
- Incidental warnings stay off stdout. To debug field issues, set
  `CT_ENFORCE_DEBUG=1`; `0`, `false`, `no`, and `off` keep the hooks quiet.

If `Stop` says you sealed to one root but it is enforcing another, the hook is
working: the turn wrote a task chain while identity enforcement watched the
identity chain. For audits, use the official task/audit protocol:

```bash
SK=~/.codex/skills/cypher-tempre-self-model
TASK_ROOT=/path/to/repo/.codex/cypher-tempre/<task-name>
python3 $SK/continuum.py walk --path /path/to/repo --ext .py .ts --objective "<task>" --root $TASK_ROOT
python3 $SK/audit.py open --root $TASK_ROOT --objective "<task>"
python3 $SK/audit.py next --root $TASK_ROOT --batch-size 10
python3 $SK/audit.py record --root $TASK_ROOT --block <ids> --finding "<specific review>"
python3 $SK/task.py complete --task-root $TASK_ROOT --report /path/to/report.md
```

Pass the task **project root** (`$TASK_ROOT`, the folder containing `chain/`), not
`$TASK_ROOT/chain`; passing the `chain/` folder creates an accidental
`chain/chain` ledger. Do not use a loose `recall.py turn --root audit` as the
only audit seal. Task chains remain readable after the task with
`recall.py ... --root $TASK_ROOT` or `continuum.py resume --root $TASK_ROOT`, and
`task.py complete` seals a verified pointer to that task head into identity.

Or ask Codex to install it from the repository source ZIP:

```text
Install the Codex skill from this repository:

https://github.com/cyberphysicsai/cypher-tempre-genesis/archive/refs/heads/main.zip

Use only this folder from the ZIP:
skills/codex/cypher-tempre-self-model

Copy that folder into my Codex skills directory as cypher-tempre-self-model, then run python3 timechain.py verify inside it to verify the install.
```

Then ask Codex:

```text
Run python3 install_codex_hooks.py inside the installed cypher-tempre-self-model skill folder, then help me review the hooks with /hooks.
```

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
