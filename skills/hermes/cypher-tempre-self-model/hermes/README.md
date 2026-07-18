# Cypher Tempre on Hermes — hook-level enforcement

Cypher Tempre v3.28.01 uses Hermes' real shell-hook system to make the
per-turn loop visible and accountable on every Hermes turn.

## Why this exists

Earlier Hermes bundles copied the Claude/Codex hook scripts unchanged. Those
scripts emitted Claude's context envelope:

```json
{"hookSpecificOutput":{"additionalContext":"..."}}
```

Hermes does **not** read that key for lifecycle context. Hermes' shell-hook
bridge (`agent/shell_hooks.py`) injects only a top-level:

```json
{"context":"..."}
```

So the old reminder could be silently dropped by Hermes even though the script
ran successfully. v3.28.01 fixes that by emitting a **union envelope** from
`enforce.py`: top-level `context` for Hermes plus the legacy
`hookSpecificOutput.additionalContext` for Claude/Codex compatibility.

## Hook mapping

Wire these commands in `~/.hermes/config.yaml`:

```yaml
hooks:
  pre_llm_call:
    - command: "/absolute/path/to/cypher-tempre-self-model/hermes/pre_llm_call.sh"
      timeout: 30
  post_llm_call:
    - command: "/absolute/path/to/cypher-tempre-self-model/hermes/post_llm_call.sh"
      timeout: 30
  subagent_stop:
    - command: "/absolute/path/to/cypher-tempre-self-model/hermes/subagent_stop.sh"
      timeout: 30
hooks_auto_accept: true
```

Or install idempotently:

```bash
python3 /absolute/path/to/cypher-tempre-self-model/hermes/install_hooks.py
hermes hooks list
hermes hooks doctor
```

## What each hook does

- `pre_llm_call` fires once per user turn before the tool loop. It is the only
  Hermes lifecycle hook whose return value is injected into the current turn.
  Cypher Tempre uses it to mark turn-start, inject the loop reminder, prime the
  first turn, and surface unpaid seal debt.
- `post_llm_call` fires once after a successful assistant response. Hermes
  ignores this hook's return value, so it **cannot hard-block** the response the
  way Claude's `Stop` hook can. Cypher Tempre therefore records seal debt when
  the turn ended without a ring or audit progress; the next `pre_llm_call`
  escalates that debt into a seal-or-waive demand.
- `subagent_stop` fires after `delegate_task` children return. Hermes ignores
  its return value too, so it records/account-checks delegated work and carries
  any debt forward.

## Honest enforcement boundary

Hermes currently has a pre-turn context hook and a pre-tool block hook, but no
turn-end hook whose return value can stop the final answer. Therefore v3.28.01
implements the strongest hook-level-compliant mechanism available without
patching Hermes core:

1. inject the loop on every turn through `pre_llm_call`;
2. record turn-end noncompliance through `post_llm_call` / `subagent_stop`;
3. carry failures as explicit seal debt;
4. force the next turn's context to confront that debt until the model seals or
   runs `enforce.py waive "<reason>"`, which leaves telemetry.

This is not merely advisory: every skipped turn becomes auditable debt, and the
next Hermes turn is re-grounded before the model acts again. A literal same-turn
hard stop would require Hermes core to honor a block directive from
`post_llm_call` or `subagent_stop`.

## Debugging

- Hooks fail open by design; they must never break a Hermes session.
- Set `CT_ENFORCE_DEBUG=1` before launching Hermes to let hook stderr surface.
- Run `python3 hermes/install_hooks.py --check` to inspect config wiring.
- Run `hermes hooks test` / `hermes hooks doctor` to exercise Hermes' shell-hook
  bridge and allowlist state.

## Consent

Hermes requires approval for shell hooks. For CLI use, Hermes can prompt once and
persist consent in `~/.hermes/shell-hooks-allowlist.json`. For gateway/cron or
other non-TTY sessions, set `hooks_auto_accept: true` or launch with
`HERMES_ACCEPT_HOOKS=1` / `--accept-hooks`.
