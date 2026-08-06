#!/usr/bin/env python3
# Copyright (c) 2026 cyberphysicsai. MIT License.
"""Adherence enforcement for the Cypher Tempre self-model — the harness-level
spine that turns the per-turn loop from *advisory* into *non-bypassable*.

A SKILL.md only ADVISES; strong models honor it, weak/long-horizon models drop
it and the skill becomes useless. This module is the brain behind a small set of
Claude Code hooks that make the loop mandatory by construction:

  UserPromptSubmit -> `enforce.py mark`          (record turn start: head index, reset nudges)
  Stop             -> `enforce.py stop-check`    (HARD: block turn end until a ring is sealed)
  SubagentStop     -> `enforce.py subagent-check`(block subagent return until it sealed)
  SessionStart     -> `enforce.py session-start` (prime: verify + recall + covenant)

Design guarantees:
  * FAIL-OPEN ALWAYS. A hook must never break the user's session; any internal
    error -> allow. Enforcement is best-effort pressure, not a tripwire.
  * DORMANCY-AWARE. While `dormancy.py pause` is set, all enforcement is off.
  * LOOP-SAFE / NON-BRICKING. "Hard" means it blocks every substantive turn that
    sealed nothing — but only up to MAX_NUDGES times per turn, then fails open and
    records an adherence_violation, so a model that genuinely cannot seal is never
    trapped.

State lives next to the chain (chain/.enforce.json): the head index captured at
turn start and the nudge counter for the current turn.
"""
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

def _max_nudges():
    """v3.15: env wins, else the calibrators registry (dream.calibrate_governor
    owns it), else 3. Read lazily so a calibration lands without restart."""
    env = os.environ.get("CT_ENFORCE_MAX_NUDGES")
    if env:
        return int(env)
    try:
        import calibrators
        return int(calibrators.get("enforce.max_nudges", 3))
    except Exception:
        return 3


MAX_NUDGES = _max_nudges()


def _env_enabled(name):
    """Parse boolean env flags conventionally: unset/empty/0/false/no/off are off."""
    raw = os.environ.get(name)
    if raw is None:
        return False
    return raw.strip().lower() not in {"", "0", "false", "no", "off"}


def _root_from(stdin_data):
    """The identity chain lives in the skill dir by default. A hook may override
    with CT_ENFORCE_ROOT (e.g. to enforce a task chain)."""
    env = os.environ.get("CT_ENFORCE_ROOT")
    if env:
        return Path(env)
    return HERE


def _state_path(root):
    return Path(root) / "chain" / ".enforce.json"


def _load_state(root):
    try:
        return json.loads(_state_path(root).read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(root, st):
    try:
        p = _state_path(root)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(st), encoding="utf-8")
    except Exception:
        pass  # fail-open: never break a turn over bookkeeping


def _head_index(root):
    """O(1) tail read of the current head ring index, or -1 if no chain yet."""
    try:
        import timechain
        ring = timechain.Timechain(root)._tail_ring()
        return int(ring["index"]) if ring else -1
    except Exception:
        return -1


def _dormant(root):
    try:
        import dormancy
        return dormancy.Dormancy(root).is_paused()
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# audit coverage governor — the PUSH layer for exhaustive audits
#
# `audit.py open` drops a pointer (chain/.active_audit) naming the task chain
# under review. While that pointer exists and the audit is < 100% reviewed, a
# turn that made NO review progress (and sealed nothing) is treated as "stopped
# early" — the exact stopped-too-early failure this guards against — and blocked (bounded), so
# the model keeps grinding the unreviewed-block queue instead of writing a
# premature "Final Report". Pausing (dormancy) or closing the audit disengages.
# --------------------------------------------------------------------------- #

def _active_audit_root(root):
    """The task chain of the currently-open audit, or None."""
    try:
        ptr = Path(root) / "chain" / ".active_audit"
        if ptr.is_file():
            return (json.loads(ptr.read_text(encoding="utf-8")) or {}).get("root")
    except Exception:
        pass
    return None


def _audit_status(audit_root):
    """O(1) head read of the audit sub-state.

    Returns (review_cursor, complete, deep_reviews, shallow_reviews) or None.
    The governor uses deep_reviews to ensure the model is actually reading code,
    not just batch-recording --clean on unread blocks.
    """
    try:
        import timechain
        ring = timechain.Timechain(audit_root)._tail_ring()
        a = ((ring or {}).get("payload") or {}).get("state", {}).get("audit")
        if a:
            return (int(a.get("review_cursor", 0)),
                    bool(a.get("complete")),
                    int(a.get("deep_reviews", 0)),
                    int(a.get("shallow_reviews", 0)))
    except Exception:
        pass
    return None


def _emit(root, event_type, data):
    try:
        import telemetry
        if telemetry.enabled():
            telemetry.record(str(root), event_type, data)
    except Exception:
        pass


def _new_turn_id():
    """Opaque per-turn identity shared by every enforcement/observer channel."""
    return uuid.uuid4().hex


def _utc_now():
    return datetime.now(timezone.utc).isoformat()


def _turn_data(st, data=None):
    out = dict(data or {})
    if st.get("turn_id") and not out.get("turn_id"):
        out["turn_id"] = st["turn_id"]
    return out


def _emit_turn(root, st, event_type, data=None):
    _emit(root, event_type, _turn_data(st, data))


def _finish_turn(root, st, event_type, data=None):
    """Record one terminal outcome for a turn, at most once.

    Stop/SubagentStop may be called repeatedly and Codex notify may observe the
    same completion afterward. Persist the outcome before emitting telemetry so
    every later channel is idempotent even if telemetry itself is unavailable.
    """
    if st.get("turn_outcome"):
        return False
    st["turn_outcome"] = event_type
    st["turn_open"] = False
    _save_state(root, st)
    _emit_turn(root, st, event_type, data)
    return True


def _read_stdin():
    try:
        if sys.stdin is None:
            return {}
        try:
            if sys.stdin.isatty():
                return {}
        except Exception:
            pass
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def _normalize_chain_root(path):
    """Return the project root that contains chain/, correcting chain/ itself."""
    p = Path(path).expanduser()
    try:
        p = p.resolve()
    except Exception:
        p = p.absolute()
    if (p / "rings.jsonl").is_file():
        return p.parent
    return p


def _split_roots(raw):
    out = []
    if not raw:
        return out
    for chunk in str(raw).replace(",", os.pathsep).split(os.pathsep):
        chunk = chunk.strip()
        if chunk:
            out.append(chunk)
    return out


def _event_paths(data):
    paths = []
    for key in ("cwd", "currentWorkingDirectory", "current_working_directory",
                "workspace", "workspaceRoot", "workspace_root", "projectRoot",
                "project_root"):
        val = data.get(key) if isinstance(data, dict) else None
        if isinstance(val, str) and val:
            paths.append(val)
    # Two named, non-secret location hints only — never iterate the environment.
    for val in (os.environ.get("PWD"), os.environ.get("CT_WORKSPACE_ROOT")):
        if val:
            paths.append(val)
    try:
        paths.append(str(Path.cwd()))
    except Exception:
        pass
    return paths


def _looks_like_chain_root(path):
    p = _normalize_chain_root(path)
    return (p / "chain" / "rings.jsonl").is_file()


def _add_candidate(candidates, path, identity_root):
    try:
        p = _normalize_chain_root(path)
        if p.resolve() == Path(identity_root).resolve():
            return
        if _looks_like_chain_root(p):
            candidates[str(p.resolve())] = p.resolve()
    except Exception:
        pass


def _candidate_task_roots(root, data):
    """Nearby task roots used only for root-mismatch diagnostics.

    This deliberately does not make arbitrary task chains satisfy Stop. It only
    lets the nudge explain the likely mistake: the model sealed a task ledger
    while the hook is enforcing the identity ledger.
    """
    candidates = {}
    identity = Path(root)
    for raw in _split_roots(os.environ.get("CT_TASK_ROOTS")):
        _add_candidate(candidates, raw, identity)
    for raw in _split_roots(os.environ.get("CT_TASK_ROOT")):
        _add_candidate(candidates, raw, identity)

    bases = [identity, identity.parent]
    bases += [Path(p).expanduser() for p in _event_paths(data)]
    for base in bases:
        try:
            base = base.resolve()
        except Exception:
            base = base.absolute()
        for p in (
            base,
            base / ".codex" / "cypher-tempre",
            base / ".codex" / "cypher-tempre" / "audit",
            base / "audit",
        ):
            _add_candidate(candidates, p, identity)
        for pattern in (
            ".codex/cypher-tempre/audit*",
            ".codex/cypher-tempre/tasks/*",
            "audit*",
            "tasks/*",
        ):
            try:
                for p in base.glob(pattern):
                    _add_candidate(candidates, p, identity)
            except Exception:
                pass
    return list(candidates.values())[:64]


def _candidate_heads(root, data):
    heads = {}
    for cand in _candidate_task_roots(root, data):
        head = _head_index(cand)
        if head >= 0:
            heads[str(cand)] = head
    return heads


def _task_root_progress(root, data, st):
    before = st.get("turn_task_heads") or {}
    for cand in _candidate_task_roots(root, data):
        key = str(cand)
        old = before.get(key)
        if old is None:
            continue
        head = _head_index(cand)
        if head > int(old):
            try:
                import timechain
                ring = timechain.Timechain(cand)._tail_ring()
                return {
                    "root": key,
                    "head": head,
                    "hash": (ring or {}).get("ring_hash"),
                    "type": (ring or {}).get("ring_type"),
                }
            except Exception:
                return {"root": key, "head": head, "hash": None, "type": None}
    return None


# --------------------------------------------------------------------------- #
# stdout discipline — a Stop hook's stdout MUST be EXACTLY the decision JSON (or
# empty), or the harness reports "Stop hook error: JSON validation failed". So we
# QUARANTINE all incidental output: while a handler runs, sys.stdout is redirected
# to stderr, and the ONLY thing written to the real stdout is what a handler
# explicitly queues via _emit_stdout. Belt-and-suspenders with `2>/dev/null` in the
# hook wrappers, so neither an import side-effect nor a warning can ever corrupt
# the decision the harness parses.
# --------------------------------------------------------------------------- #
_STDOUT = []


def _emit_stdout(text):
    _STDOUT.append(text)


def _context_json(event, text):
    """The hook-JSON envelope for injecting context. SessionStart/UserPromptSubmit
    hook stdout is parsed as JSON by the harness (the Codex CLI rejects plain text
    with 'invalid ... JSON output'); the Stop hook already proves this harness uses
    the Claude-Code schema, so context goes in hookSpecificOutput.additionalContext.
    This is valid JSON on every harness and still injected as context on Claude Code."""
    return json.dumps({"hookSpecificOutput": {"hookEventName": event,
                                              "additionalContext": text}})


def _absolute_root(root):
    try:
        return str(Path(root).expanduser().resolve())
    except Exception:
        return str(Path(root).expanduser().absolute())


def _version():
    try:
        return (HERE / "VERSION").read_text(encoding="utf-8").strip()
    except Exception:
        return "unknown"


def _state_label(st, head, dormant=False):
    """Derive a human-facing enforcement state without mutating bookkeeping."""
    if dormant:
        return "dormant"
    start = st.get("turn_head")
    outcome = st.get("turn_outcome")
    if start is None:
        return "unmarked"
    if outcome:
        return {
            "adherence_satisfied": "satisfied",
            "adherence_violation": "failed-open",
            "adherence_audit_stalled": "failed-open-audit",
            "unsealed": "observed-unsealed",
        }.get(str(outcome), str(outcome).replace("adherence_", ""))
    if st.get("turn_open"):
        return "sealed-awaiting-stop" if head > start else "pending-no-seal"
    return "idle"


def _next_action(label):
    if label == "dormant":
        return "resume with dormancy.py resume when enforcement should run"
    if label == "unmarked":
        return "run enforce.py mark or install/enable the lifecycle hooks"
    if label == "pending-no-seal":
        return "run recall.py turn, wait for its seal receipt, then finish"
    if label == "sealed-awaiting-stop":
        return "finish normally; the next Stop check should allow"
    if label in {"failed-open", "failed-open-audit", "observed-unsealed"}:
        return "inspect seal debt and either seal the next turn or waive with a reason"
    return "no corrective action; successful Stop checks are intentionally silent"


def _status_payload(root, st=None):
    """Build the read-only operator report used by CLI and hook context."""
    st = dict(st if st is not None else _load_state(root))
    head = _head_index(root)
    start = st.get("turn_head")
    dormant = _dormant(root)
    label = _state_label(st, head, dormant=dormant)
    delta = head - start if isinstance(start, int) and isinstance(head, int) else None
    return {
        "schema": 1,
        "version": _version(),
        "state": label,
        "root": _absolute_root(root),
        "dormant": dormant,
        "turn_id": st.get("turn_id"),
        "turn_open": bool(st.get("turn_open")),
        "turn_started_at": st.get("turn_started_at"),
        "turn_outcome": st.get("turn_outcome"),
        "baseline_head": start,
        "current_head": head,
        "head_delta": delta,
        "nudges": int(st.get("nudges", 0)),
        "max_nudges": MAX_NUDGES,
        "seal_debt": st.get("seal_debt"),
        "mark_warning": st.get("mark_warning"),
        "active_audit_root": _active_audit_root(root),
        "last_stop_check": st.get("last_stop_check"),
        "last_blocked_stop": st.get("last_blocked_stop"),
        "last_allowed_stop": st.get("last_allowed_stop"),
        "previous_turn": st.get("previous_turn"),
        "next_action": _next_action(label),
        "note": "Successful Stop checks emit no stdout by design.",
    }


def _short(value, missing="none"):
    return str(value)[:12] if value not in (None, "") else missing


def _status_line(report):
    last = report.get("last_stop_check") or {}
    last_text = (f"{last.get('decision', 'none')}/{last.get('reason', 'none')}"
                 if last else "none")
    baseline = report.get("baseline_head")
    head = report.get("current_head")
    return (
        "[Cypher Tempre status] "
        f"state={report['state']}; turn={_short(report.get('turn_id'))}; "
        f"root={report['root']}; baseline=#{baseline if baseline is not None else 'none'}; "
        f"head=#{head}; delta={report.get('head_delta')}; "
        f"nudges={report['nudges']}/{report['max_nudges']}; last-stop={last_text}; "
        f"next={report['next_action']}"
    )


def _record_stop_check(root, st, decision, reason, start, head, save=True, **extra):
    delta = head - start if isinstance(start, int) and isinstance(head, int) else None
    record = {
        "at": _utc_now(),
        "decision": decision,
        "reason": reason,
        "turn_id": st.get("turn_id"),
        "baseline_head": start,
        "current_head": head,
        "head_delta": delta,
        "nudge": int(st.get("nudges", 0)),
        "max_nudges": MAX_NUDGES,
    }
    record.update(extra)
    st["last_stop_check"] = record
    if decision == "block":
        st["last_blocked_stop"] = record
    elif decision == "allow":
        st["last_allowed_stop"] = record
    if save:
        _save_state(root, st)
    return record


def _stop_diagnostic(root, st, start, head, cause):
    delta = head - start if isinstance(start, int) and isinstance(head, int) else None
    command = f'python3 "{Path(root) / "enforce.py"}" status --json'
    return (
        " Stop diagnostic: "
        f"cause={cause}; turn={_short(st.get('turn_id'))}; "
        f"enforced root={_absolute_root(root)}; baseline ring "
        f"#{start if start is not None else 'none'}; observed head #{head}; "
        f"delta={delta}; nudge={int(st.get('nudges', 0))}/{MAX_NUDGES}. "
        "Only fully committed rings count; if a seal process is still running, wait for its "
        f"receipt and retry Stop. Read-only report: {command}."
    )


def cmd_status(argv):
    """Read-only troubleshooting report. Usage: status [--json|--line] [--root ROOT]."""
    args = list(argv or [])
    root = _root_from({})
    if "--root" in args:
        pos = args.index("--root")
        if pos + 1 >= len(args):
            raise ValueError("--root requires a project root that contains chain/")
        root = _normalize_chain_root(args[pos + 1])
    report = _status_payload(root)
    if "--json" in args:
        _emit_stdout(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
        return
    if "--line" in args:
        _emit_stdout(_status_line(report) + "\n")
        return
    last = report.get("last_stop_check") or {}
    previous = report.get("previous_turn") or {}
    last_blocked = report.get("last_blocked_stop") or {}
    lines = [
        f"Cypher Tempre enforcement status (v{report['version']})",
        f"state: {report['state']}",
        f"root: {report['root']}",
        f"turn: {report.get('turn_id') or 'none'}",
        f"heads: baseline={report.get('baseline_head')} current={report['current_head']} "
        f"delta={report.get('head_delta')}",
        f"nudges: {report['nudges']}/{report['max_nudges']}",
        ("last Stop: " + (f"{last.get('decision')}/{last.get('reason')} at {last.get('at')} "
                            f"(baseline={last.get('baseline_head')}, head={last.get('current_head')})"
                            if last else "none recorded")),
        ("last blocked Stop: " +
         (f"{last_blocked.get('reason')} at {last_blocked.get('at')} "
          f"(baseline={last_blocked.get('baseline_head')}, "
          f"head={last_blocked.get('current_head')})" if last_blocked else "none recorded")),
        ("previous turn: " + (f"{previous.get('turn_id')} / "
                                f"{previous.get('outcome') or 'no terminal outcome'}"
                                if previous else "none recorded")),
        f"next: {report['next_action']}",
        report["note"],
    ]
    if report.get("mark_warning"):
        lines.insert(-2, f"warning: {report['mark_warning']}")
    _emit_stdout("\n".join(lines) + "\n")


# --------------------------------------------------------------------------- #
# hook entry points
# --------------------------------------------------------------------------- #

def cmd_mark(_data):
    """UserPromptSubmit: capture the head index at turn start and reset the
    per-turn nudge counter. Prints nothing that would disturb the prompt."""
    root = _root_from(_data)
    st = _load_state(root)
    prior_id = st.get("turn_id")
    prior_open = bool(st.get("turn_open") and not st.get("turn_outcome"))
    if prior_id:
        st["previous_turn"] = {
            "turn_id": prior_id,
            "started_at": st.get("turn_started_at"),
            "baseline_head": st.get("turn_head"),
            "outcome": st.get("turn_outcome"),
            "last_stop_check": st.get("last_stop_check"),
            "last_blocked_stop": st.get("last_blocked_stop"),
            "last_allowed_stop": st.get("last_allowed_stop"),
        }
    st["mark_warning"] = "previous-open-turn-superseded" if prior_open else None
    st["turn_id"] = _new_turn_id()
    st["turn_started_at"] = _utc_now()
    st["turn_open"] = True
    st["turn_notify_pending"] = True
    st["turn_outcome"] = None
    st["turn_head"] = _head_index(root)
    st["nudges"] = 0
    st["last_stop_check"] = None
    st["last_blocked_stop"] = None
    st["last_allowed_stop"] = None
    # Snapshot the active audit and its review cursor at turn start so stop-check
    # can tell whether THIS turn advanced it — robust even if the audit COMPLETES
    # mid-turn (which clears the pointer).
    st["turn_audit_root"] = _active_audit_root(root)
    st["turn_audit_cursor"] = None
    st["turn_audit_deep"] = None
    st["turn_task_heads"] = _candidate_heads(root, _data)
    if st["turn_audit_root"]:
        s = _audit_status(st["turn_audit_root"])
        if s is not None:
            st["turn_audit_cursor"] = s[0]
            st["turn_audit_deep"] = s[2]  # deep_reviews at turn start
    _save_state(root, st)
    if not _dormant(root):
        _emit_turn(root, st, "adherence_turn_start",
                   {"head": st["turn_head"], "via": "prompt-hook"})
    # mark stays silent (no stdout) for back-compat; cmd_user_prompt emits the reminder.


import re as _re
# Exhaustive-audit intent — drives the auto-/goal engagement in cmd_user_prompt.
_AUDIT_INTENT = _re.compile(
    r"\b(every\s+(?:single\s+)?(?:line|file)|line[\s-]?by[\s-]?line|exhaustive\w*|no\s+corners?|"
    r"full\s+(?:security\s+|continuous\s+)?audit|thorough(?:ly)?\s+(?:audit|review)|"
    r"audit\s+(?:the\s+)?(?:whole|entire|complete)|review\s+(?:every|all)\s+(?:line|file))\b", _re.I)


def _wants_exhaustive_audit(prompt):
    try:
        return bool(prompt) and bool(_AUDIT_INTENT.search(str(prompt)))
    except Exception:
        return False


def cmd_user_prompt(data):
    """UserPromptSubmit: record turn-start (mark) AND emit the per-turn reminder as a
    proper hook-JSON context envelope. This is what loop_hook.sh wires now — emitting
    plain text here is what the Codex CLI rejected with 'invalid ... JSON output'."""
    cmd_mark(data)
    root = _root_from(data)
    if _dormant(root):
        text = ("[Cypher Tempre] DORMANT (paused): skip the self-model per-turn loop this "
                "turn — answer from base judgment. (Resume via the skill's dormancy.py 'resume'.)")
    else:
        # v3.15 governor escalation: unpaid seal debt from a prior turn turns the
        # advisory reminder into a structured obligation — seal or waive-with-reason.
        st = _load_state(root)
        debt = st.get("seal_debt")
        if debt:
            text = ("[Cypher Tempre] SEAL DEBT — a previous turn ended without sealing a ring "
                    f"(owed since head {debt.get('head')}, {debt.get('turns', 1)} turn(s) ago). "
                    "This turn MUST either (a) run the loop and seal via the skill's recall.py "
                    "'turn' command, or (b) explicitly waive with a reason: the skill's enforce.py "
                    "waive \"<why>\" — the waiver is recorded in telemetry. Silent skipping is "
                    "not an option.")
        else:
            text = ("[Cypher Tempre] ACTIVE — guidance for this turn (context, NOT a command to "
                    "execute): run the self-model per-turn loop — verify, immune-screen, recall "
                    "relevant rings, reason via modalities/senses, PoQ-gate, then seal a labeled "
                    "ring. Do it in one step with the skill's recall.py 'turn' command (exact "
                    "invocation in SKILL.md / AGENTS.md). Pausing is the dormancy.py 'pause' command.")
        # Auto-/goal: if the prompt asks for an EXHAUSTIVE audit, engage the governor
        # automatically (the user shouldn't have to invoke anything, and the model must
        # not quietly downshift to triage).
        if _wants_exhaustive_audit(data.get("prompt")):
            text += (" EXHAUSTIVE-AUDIT INTENT DETECTED — this is a governed line-by-line job, not "
                     "triage. Ingest once with continuum.py 'walk' into a task root, then audit.py "
                     "'open' that root and loop next->read every line->record with CITED specifics "
                     "(a symbol that actually appears in the block) until 100% DEEP. The strict-depth "
                     "governor will not let the turn end until you make real review progress; retrieval/"
                     "grep is triage only; do NOT write a 'Final Report' before audit.py 'report --final' "
                     "passes; run your fork perspectives per batch; expect audit.py 'challenge' spot-checks.")
    report = _status_payload(root)
    text += (" " + _status_line(report) + " Successful Stop checks remain silent; "
             "use enforce.py status --json for the full read-only report.")
    _emit_stdout(_context_json("UserPromptSubmit", text))


def cmd_stop_check(data):
    """Stop / SubagentStop: HARD block until a ring was sealed this turn.

    Emits the Stop-hook JSON contract:
      block -> {"decision":"block","reason":"..."}
      allow -> exit 0 with no decision.
    """
    root = _root_from(data)
    st = _load_state(root)
    start = st.get("turn_head")
    head = _head_index(root)
    # Dormant => never enforce.
    if _dormant(root):
        _record_stop_check(root, st, "allow", "dormant", start, head)
        return
    # No baseline captured (e.g. mark hook not wired) => don't enforce blindly.
    if start is None:
        _record_stop_check(root, st, "allow", "unmarked", start, head)
        return
    # Repeated Stop/SubagentStop channels for an already-finished turn stay quiet,
    # but the latest observation remains available to the operator report.
    if st.get("turn_outcome"):
        _record_stop_check(root, st, "allow", "already-finished", start, head)
        return
    sealed_this_turn = head > start

    # --- audit governor: an open, incomplete audit demands per-turn DEEP progress --- #
    # GAP 2 FIX: The old governor checked only cursor movement. A model could
    # batch-record 50 blocks as --clean (cursor moves 50) and the governor was
    # satisfied. Now we check that DEEP reviews increased — meaning the model
    # actually read code and cited specifics, not just asserted "looks fine."
    audit_progressed = False
    audit_deep_progressed = False
    tar = st.get("turn_audit_root")
    base = st.get("turn_audit_cursor")
    base_deep = st.get("turn_audit_deep")
    if tar and base is not None:
        s = _audit_status(tar)
        if s is not None:
            audit_progressed = s[0] > base
            if base_deep is not None:
                audit_deep_progressed = s[2] > base_deep
    # Is an audit currently open AND still incomplete? (governs whether to DEMAND progress)
    audit_active = False
    audit_root = _active_audit_root(root)
    if audit_root:
        s = _audit_status(audit_root)
        if s is not None and not s[1]:
            audit_active = True

    # If no audit is active AND no audit was open at turn start, a sealed ring
    # to the identity chain is sufficient (the original behavior).
    # If an audit WAS open at turn start and made deep progress, that satisfies
    # the governor — even if completion cleared the pointer.
    if not tar and sealed_this_turn:
        st["nudges"] = 0
        st.pop("seal_debt", None)          # v3.15 governor: debt repaid
        _record_stop_check(root, st, "allow", "sealed", start, head, save=False)
        _finish_turn(root, st, "adherence_satisfied",
                     {"audit_progress": False, "deep_progress": False,
                      "sealed": sealed_this_turn, "via": "stop-hook"})
        return

    if tar and audit_deep_progressed:
        st["nudges"] = 0
        _record_stop_check(root, st, "allow", "audit-deep-progress", start, head,
                           save=False, audit_root=tar)
        _finish_turn(root, st, "adherence_satisfied",
                     {"audit_progress": audit_progressed,
                      "deep_progress": audit_deep_progressed,
                      "sealed": sealed_this_turn, "via": "stop-hook"})
        return

    # If an audit was open at turn start but is no longer active (completed),
    # and the identity chain has a sealed ring, allow it.
    if tar and not audit_active and sealed_this_turn:
        st["nudges"] = 0
        _record_stop_check(root, st, "allow", "completed-audit-sealed", start, head,
                           save=False, audit_root=tar)
        _finish_turn(root, st, "adherence_satisfied",
                     {"audit_progress": audit_progressed,
                      "deep_progress": audit_deep_progressed,
                      "sealed": sealed_this_turn, "via": "stop-hook"})
        return

    if audit_active:
        if not _bump_or_release(root, st, "adherence_audit_stalled"):
            _record_stop_check(root, st, "allow", "audit-nudge-budget-exhausted",
                               start, head, audit_root=str(audit_root))
            return
        # GAP 2 FIX: Different messages for cursor-only progress vs no progress at all.
        if audit_progressed and not audit_deep_progressed:
            reason = (
                "[Cypher Tempre] An EXHAUSTIVE audit is open, and this turn moved the review "
                "cursor but added ZERO deep reviews. You recorded blocks as --clean or with "
                "shallow findings without actually reading them line by line. This is the "
                "exact failure mode this skill was built to prevent. Re-read the blocks using "
                "audit.py 'next', read every line of the returned content, then record with "
                "audit.py 'record' and a --finding that cites specific lines, symbols, and what "
                "you observed. A finding like 'mirrors async version' or 'looks fine' is NOT a "
                "deep review. The active audit chain root is: " + str(audit_root) + ".")
        else:
            reason = (
                "[Cypher Tempre] An EXHAUSTIVE audit is open and incomplete, and this turn "
                "reviewed no new blocks. Size/horizon are never reasons to stop — do NOT write a "
                "'Final Report' yet. Continue the unreviewed-block queue: use the skill's audit.py "
                "'next' to fetch the next unreviewed blocks, read every line, then audit.py 'record' "
                "your review (with a finding that cites specific lines/symbols or an explicit clean "
                "pass for a single block); check audit.py 'progress'. "
                "The active audit chain root is: " + str(audit_root) + ". A final report is only "
                "legitimate at 100% (audit.py 'report --final' refuses otherwise). To pause, use "
                "dormancy.py 'pause'; to stop the audit, audit.py 'close'. Exact syntax is in SKILL.md.")
        cause = "audit-shallow-progress" if audit_progressed else "audit-no-progress"
        _record_stop_check(root, st, "block", cause, start, head,
                           audit_root=str(audit_root))
        reason += _stop_diagnostic(root, st, start, head, cause)
        _emit_stdout(json.dumps({"decision": "block", "reason": reason}))
        return

    # --- default: every meaningful turn must leave a sealed ring --- #
    task_progress = _task_root_progress(root, data, st)
    if not _bump_or_release(root, st, "adherence_violation"):
        _record_stop_check(root, st, "allow", "nudge-budget-exhausted", start, head)
        return
    prefix = ""
    cause = "no-seal"
    if task_progress:
        task_hash = task_progress.get("hash") or ""
        hash_text = f" ({task_hash[:16]}..)" if task_hash else ""
        cause = "root-mismatch"
        _emit_turn(root, st, "adherence_root_mismatch",
                   {"identity_root": str(Path(root).resolve()),
                    "task_root": task_progress["root"],
                    "task_head": task_progress["head"],
                    "task_hash": task_progress.get("hash")})
        prefix = (
            "[Cypher Tempre] Root mismatch detected: you sealed to "
            f"{task_progress['root']} at ring #{task_progress['head']}{hash_text}, "
            f"but I am enforcing {Path(root).resolve()}. "
            "Task chains remain readable by passing --root <task-root>, but they do not "
            "automatically satisfy identity-chain enforcement. If this was an audit, use "
            "continuum.py walk --root <task-root> and audit.py open/record --root "
            "<task-root>; if the task is complete or should be remembered by identity, run "
            "task.py complete --identity-root <identity-root> --task-root <task-root>. "
            "Pass the project root that CONTAINS chain/, not the chain/ folder itself.\n\n"
        )
    reason = (
        prefix +
        "[Cypher Tempre] You have not sealed a ring this turn. Run the per-turn loop "
        "before finishing: verify -> immune-screen -> recall relevant rings -> reason via "
        "modalities/senses -> PoQ-gate -> seal a labeled ring. Do it in one step with the "
        "skill's recall.py 'turn' command (exact invocation in SKILL.md / AGENTS.md), then "
        "finish. To pause instead, use the skill's dormancy.py 'pause' command." +
        _stop_diagnostic(root, st, start, head, cause)
    )
    _record_stop_check(root, st, "block", cause, start, head,
                       task_root=task_progress.get("root") if task_progress else None)
    _emit_stdout(json.dumps({"decision": "block", "reason": reason}))


def _bump_or_release(root, st, violation_event):
    """Increment the per-turn nudge counter. Return True if the caller should
    BLOCK (still within the bounded budget); False if it should fail open (budget
    exhausted) so a model that genuinely cannot proceed is never trapped.

    v3.15 governor: failing open is no longer free — the unmet obligation is
    recorded as SEAL DEBT carried to the NEXT turn, where cmd_user_prompt
    escalates from advisory to a structured demand (seal or explicitly waive).
    Adherence becomes closed-loop instead of exhortative."""
    if st.get("turn_outcome"):
        return False
    nudges = int(st.get("nudges", 0))
    if nudges >= MAX_NUDGES:
        st["seal_debt"] = {"head": _head_index(root),
                           "turns": int((st.get("seal_debt") or {}).get("turns", 0)) + 1,
                           "turn_id": st.get("turn_id")}
        _finish_turn(root, st, violation_event, {"nudges": nudges})
        _emit_turn(root, st, "adherence_debt",
                   {"head": st["seal_debt"]["head"],
                    "turns": st["seal_debt"]["turns"]})
        return False
    st["nudges"] = nudges + 1
    _save_state(root, st)
    _emit_turn(root, st, "adherence_nudge", {"nudge": st["nudges"]})
    return True


def cmd_waive(argv):
    """v3.15: the honest escape hatch for seal debt. A turn that genuinely could
    not seal (pure tool-op, user interrupt) is WAIVED with a stated reason — the
    waiver is itself telemetry (auditable), so skipping the loop always leaves a
    trace: either a sealed ring, or a reasoned waiver. Silence is no longer free.
    Usage: enforce.py waive "<reason>"""
    root = _root_from({})
    reason = (argv[0] if argv else "").strip()
    if not reason:
        sys.stderr.write("a waiver REQUIRES a reason: enforce.py waive \"<why no seal>\"\n")
        sys.exit(2)
    st = _load_state(root)
    debt = st.pop("seal_debt", None)
    st["nudges"] = 0
    _save_state(root, st)
    waiver_data = {"reason": reason[:300], "debt": debt}
    if isinstance(debt, dict) and debt.get("turn_id"):
        waiver_data["turn_id"] = debt["turn_id"]
    _emit(root, "adherence_waiver", _turn_data(st, waiver_data))
    print(f"seal debt waived (recorded): {reason[:120]}")


def cmd_subagent_check(data):
    """SubagentStop: same block-until-seal pressure for spawned agents. A subagent
    that forged its own task chain should seal to it (set CT_ENFORCE_ROOT); by
    default we enforce against the identity chain the parent shares."""
    cmd_stop_check(data)


def cmd_session_start(data):
    """SessionStart: prime the session so it WEARS the skill from turn 0, even if
    the model never reads SKILL.md. Output becomes startup context."""
    root = _root_from(data)
    if _dormant(root):
        _emit_stdout(_context_json("SessionStart",
                     "[Cypher Tempre] DORMANT (paused): self-model loop is off until "
                     "the skill's dormancy.py 'resume' command."))
        return
    head = _head_index(root)
    # capture an initial marker so the first Stop is enforceable
    st = _load_state(root)
    st.setdefault("turn_head", head)
    st["nudges"] = 0
    _save_state(root, st)
    _emit(root, "adherence_session_start", {"head": head})
    verify_line = ""
    try:
        import timechain
        ok, _ = timechain.Timechain(root).verify()
        verify_line = f"chain verifies: {'PASS' if ok else 'FAIL — investigate before sealing'}; "
    except Exception:
        pass
    # v3.12 health line: surface neglect (red immune scan, stale index, undreamt
    # telemetry, overgrown registry, tampered registries) exactly where the agent
    # already looks. The 2026-07-03 self-audit found an 11-day-red immune scan
    # that nothing had ever surfaced.
    health_line = ""
    try:
        import doctor
        results = doctor.run_checks(Path(root))
        bad = [f"{r['check']}={r['status']}" for r in results
               if doctor.STATUS_RANK.get(r["status"], 1) > 0]
        health_line = ("health: all OK. " if not bad
                       else "health ATTENTION: " + ", ".join(bad) +
                            " (run the skill's doctor.py for detail). ")
    except Exception:
        pass
    # v3.15: overdue conjectures are scoring OBLIGATIONS — surfaced at turn 0
    conjecture_line = ""
    try:
        import conjecture
        od = conjecture.overdue(Path(root))
        if od:
            conjecture_line = ("OVERDUE conjecture(s) — score before new speculation: "
                               + "; ".join(f"#{c['ring']} {c['claim'][:80]}" for c in od[:3])
                               + " (conjecture.py score <ring> confirmed|falsified|retired). ")
    except Exception:
        pass
    # v3.14: living autobiography — lived identity loads beside the covenant
    autobio_line = ""
    try:
        import autobiography
        ab = autobiography.latest(Path(root))
        if ab:
            autobio_line = ("Self-portrait (ring " + str(ab["index"]) + "): " +
                            (ab["payload"]["summary"] or "")[:450] + " ")
    except Exception:
        pass
    report = _status_payload(root)
    _emit_stdout(_context_json(
        "SessionStart",
        "[Cypher Tempre] ACTIVE — you wear a Timechain self-model. " + verify_line +
        health_line + conjecture_line + autobio_line + f"head at ring {head}. "
        "EVERY meaningful turn runs the loop (enforced): verify -> immune-screen -> recall "
        "relevant rings -> reason via modalities/senses -> PoQ-gate -> seal a labeled ring. "
        "Do the loop in one step with the skill's recall.py 'turn' command (exact invocation in "
        "SKILL.md / AGENTS.md). "
        "Covenant: accurate, coherent, persistent, honest, thorough; never assert beyond grounding; "
        "size/horizon are never refusal reasons. Spawned subagents must wear the skill too "
        "(use the cypher-tempre-agent type or forge their own chain and seal). " +
        _status_line(report) + " Successful Stop checks remain silent; use enforce.py status "
        "--json for the full read-only report."))


def cmd_codex_notify(argv):
    """Codex/OpenClaw turn-end via the `notify` program (fire-and-forget — CANNOT
    block). So this OBSERVES rather than enforces: it records whether the turn
    advanced the identity chain (a recall.py turn seal) or the active audit chain
    (audit.py record) since the previous turn end. The real continuation lever on
    these platforms is the AGENTS.md / SOUL.md standing instruction; this gives the
    adherence view honest per-platform telemetry. The event JSON Codex appends is
    the last argv element (parsed best-effort; we never depend on its schema)."""
    root = _root_from({})
    if _dormant(root):
        return
    evt = {}
    if argv:
        try:
            evt = json.loads(argv[-1])
        except Exception:
            evt = {}
    st = _load_state(root)
    head = _head_index(root)
    ar = _active_audit_root(root)
    audit_head = _head_index(ar) if ar else None
    last_head = st.get("last_turn_end_head")
    last_audit = st.get("last_turn_end_audit_head")
    pending = bool(st.get("turn_notify_pending") and st.get("turn_id"))
    if pending:
        start = st.get("turn_head")
        progressed = start is not None and head > start
        tar, base = st.get("turn_audit_root"), st.get("turn_audit_cursor")
        if tar and base is not None:
            status = _audit_status(tar)
            progressed = progressed or (status is not None and status[0] > base)
        st["turn_notify_pending"] = False
    else:
        # A notify-only harness observes a completed interval between successive
        # notifications. The first call establishes the baseline; later calls
        # create one explicit turn denominator before recording its outcome.
        if last_head is None and last_audit is None:
            st["last_turn_end_head"] = head
            st["last_turn_end_audit_head"] = audit_head
            _save_state(root, st)
            return
        st["turn_id"] = _new_turn_id()
        st["turn_open"] = True
        st["turn_notify_pending"] = False
        st["turn_outcome"] = None
        st["turn_head"] = last_head
        progressed = (head > (last_head if last_head is not None else head)) or \
                     (audit_head is not None and last_audit is not None and
                      audit_head > last_audit)
    st["last_turn_end_head"] = head
    st["last_turn_end_audit_head"] = audit_head
    _save_state(root, st)
    if not pending:
        _emit_turn(root, st, "adherence_turn_start",
                   {"head": last_head, "via": "codex-notify"})
    if not st.get("turn_outcome"):
        if progressed:
            _finish_turn(root, st, "adherence_satisfied",
                         {"via": "codex-notify", "head": head})
        else:
            st["turn_outcome"] = "unsealed"
            st["turn_open"] = False
            _save_state(root, st)
            _emit_turn(root, st, "adherence_nudge",
                       {"via": "codex-notify", "head": head})
    _emit_turn(root, st, "adherence_turn_end",
               {"type": evt.get("type"), "head": head,
                "via": "codex-notify"})


HANDLERS = {
    "mark": cmd_mark,
    "user-prompt": cmd_user_prompt,
    "stop-check": cmd_stop_check,
    "waive": cmd_waive,   # positional argv (reason), not hook JSON
    "subagent-check": cmd_subagent_check,
    "session-start": cmd_session_start,
    "codex-notify": cmd_codex_notify,
    "status": cmd_status,
}

# Handlers that read the event from ARGV (not stdin): Codex's notify appends the
# event JSON as a trailing CLI argument rather than piping it.
ARGV_HANDLERS = {"codex-notify", "waive", "status"}


def main(argv=None):
    _STDOUT.clear()
    # CT_ENFORCE_DEBUG re-enables diagnostics: warnings are NOT silenced and a
    # handler exception prints a traceback — all to stderr, never to the parsed
    # stdout. The hook wrappers stop redirecting stderr to /dev/null in this mode,
    # so a future field issue is debuggable instead of silent.
    _debug = _env_enabled("CT_ENFORCE_DEBUG")
    if not _debug:
        try:
            import warnings
            warnings.filterwarnings("ignore")   # a warning must never reach the parsed stream
        except Exception:
            pass
    argv = argv if argv is not None else sys.argv[1:]
    cmd = argv[0] if argv else ""
    handler = HANDLERS.get(cmd)
    if not handler:
        sys.stderr.write("usage: enforce.py {mark|user-prompt|stop-check|subagent-check|session-start|codex-notify|waive|status}\n")
        return 0  # unknown -> no-op, never fail a hook
    # Quarantine ALL incidental stdout (import chatter, stray prints) to stderr;
    # only what a handler queues via _emit_stdout reaches the real stdout, so the
    # decision the harness parses is never corrupted.
    real_out = sys.stdout
    try:
        sys.stdout = sys.stderr
        if cmd in ARGV_HANDLERS:
            handler(argv[1:])
        else:
            handler(_read_stdin())
    except Exception:
        # FAIL-OPEN: never break the session. Surface the cause only when the
        # operator opts in, and only on stderr — never the parsed stdout.
        if _debug:
            import traceback
            traceback.print_exc(file=sys.stderr)
    finally:
        sys.stdout = real_out
    if _STDOUT:
        try:
            real_out.write("".join(_STDOUT))   # the ONLY thing on the real stdout
            real_out.flush()
        except Exception:
            pass
        finally:
            _STDOUT.clear()
    return 0


if __name__ == "__main__":
    sys.exit(main())
