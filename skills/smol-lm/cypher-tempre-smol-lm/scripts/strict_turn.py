#!/usr/bin/env python3
"""Strict, transport-agnostic output gate for the Cypher Tempre Smol LM packet.

The model produces a JSON draft. This controller owns the identity root, runs the
installed Cypher Tempre engine, validates the resulting ring, and withholds the
user-facing text until a separate release operation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


PACKAGE_VERSION = "0.1.0"
STATE_SCHEMA = "cypher-tempre-smol-turn/v1"
RECEIPT_SCHEMA = "cypher-tempre-smol-receipt/v1"
TURN_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_INPUT_CHARS = 200_000
MAX_ANSWER_CHARS = 100_000
MAX_CLAIMS = 12
MAX_CLAIM_CHARS = 300


class GatewayError(RuntimeError):
    """A protocol failure safe to report without releasing model output."""


def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="strict")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha_json(value) -> str:
    return _sha_text(_canonical_json(value))


def _emit(value) -> None:
    sys.stdout.write(_canonical_json(value) + "\n")


def _emit_error(message: str) -> None:
    sys.stderr.write(_canonical_json({"error": str(message), "released": False}) + "\n")


def _atomic_write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(str(tmp), flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", errors="strict", newline="\n") as out:
            out.write(_canonical_json(value))
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _read_json(path: Path):
    try:
        with path.open("r", encoding="utf-8", errors="strict", newline="") as src:
            return json.load(src)
    except FileNotFoundError as exc:
        raise GatewayError(f"state file not found: {path}") from exc
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise GatewayError(f"state file is not valid UTF-8 JSON: {path}") from exc


def _read_text_arg(text: str | None, file_name: str | None, label: str) -> str:
    if text is not None:
        value = text
    elif file_name == "-":
        value = sys.stdin.buffer.read().decode("utf-8", errors="strict")
    elif file_name:
        value = Path(file_name).read_text(encoding="utf-8", errors="strict")
    else:
        raise GatewayError(f"{label} is required")
    if not value.strip():
        raise GatewayError(f"{label} must not be empty")
    return value


def _resolve_engine(raw: str | None) -> Path:
    selected = raw or str(Path.home() / ".codex" / "skills" / "cypher-tempre-self-model")
    engine = Path(selected).expanduser().resolve()
    for required in ("timechain.py", "recall.py", "registry"):
        if not (engine / required).exists():
            raise GatewayError(f"Cypher Tempre engine is incomplete: missing {engine / required}")
    return engine


def _resolve_existing_dir(raw: str | None, fallback: Path, label: str) -> Path:
    path = Path(raw).expanduser().resolve() if raw else fallback.resolve()
    if not path.is_dir():
        raise GatewayError(f"{label} directory does not exist: {path}")
    return path


def _read_chain(root: Path) -> list[dict]:
    ledger = root / "chain" / "rings.jsonl"
    rings = []
    try:
        with ledger.open("r", encoding="utf-8", errors="strict", newline="") as src:
            for line_number, line in enumerate(src, 1):
                if not line.strip():
                    continue
                try:
                    ring = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise GatewayError(f"invalid ring JSON at {ledger}:{line_number}") from exc
                if not isinstance(ring, dict):
                    raise GatewayError(f"non-object ring at {ledger}:{line_number}")
                rings.append(ring)
    except FileNotFoundError as exc:
        raise GatewayError(
            f"identity chain is not initialized: {ledger}; initialize the standard skill first"
        ) from exc
    except UnicodeError as exc:
        raise GatewayError(f"identity chain is not valid UTF-8: {ledger}") from exc
    if not rings:
        raise GatewayError(f"identity chain is empty: {ledger}")
    return rings


def _head(rings: list[dict]) -> dict:
    ring = rings[-1]
    return {"index": int(ring["index"]), "ring_hash": str(ring["ring_hash"])}


def _run(command: list[str], *, cwd: Path, timeout: int, check: bool = True):
    cwd = cwd.resolve()
    if len(command) < 2 or command[0] != sys.executable:
        raise GatewayError("controller may invoke only the current Python interpreter")
    script = Path(command[1]).resolve()
    if script.parent != cwd or script.name not in {"timechain.py", "recall.py"}:
        raise GatewayError("controller command is outside the allowlisted Cypher Tempre engine surface")
    if any(not isinstance(item, str) for item in command):
        raise GatewayError("controller command arguments must be strings")
    try:
        proc = subprocess.run(
            command,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=timeout,
            check=False,
            shell=False,
        )
    except subprocess.TimeoutExpired as exc:
        if check:
            raise GatewayError(f"engine command timed out after {timeout}s") from exc
        return None
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "engine command failed").strip().splitlines()
        raise GatewayError(detail[-1][:500] if detail else "engine command failed")
    return proc


def _verify(engine: Path, root: Path, timeout: int) -> None:
    _run(
        [sys.executable, str(engine / "timechain.py"), "verify", "--root", str(root)],
        cwd=engine,
        timeout=timeout,
        check=True,
    )


def _state_path(state_dir: Path, turn_id: str) -> Path:
    if not TURN_RE.fullmatch(turn_id or ""):
        raise GatewayError("turn ID must be a 32-character lowercase hexadecimal value")
    return state_dir / f"{turn_id}.json"


def _active_path(state_dir: Path) -> Path:
    return state_dir / "active.json"


def _claim_active(state_dir: Path, marker: dict) -> None:
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    active = _active_path(state_dir)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        fd = os.open(str(active), flags, 0o600)
    except FileExistsError as exc:
        existing = _read_json(active)
        raise GatewayError(
            "another turn owns this state directory: "
            f"{existing.get('turn_id', 'unknown')}; inspect it with status or cancel it explicitly"
        ) from exc
    with os.fdopen(fd, "w", encoding="utf-8", errors="strict", newline="\n") as out:
        out.write(_canonical_json(marker) + "\n")
        out.flush()
        os.fsync(out.fileno())


def _assert_active(state_dir: Path, turn_id: str) -> None:
    marker = _read_json(_active_path(state_dir))
    if marker.get("turn_id") != turn_id:
        raise GatewayError("turn does not own the active controller reservation")


def _release_active(state_dir: Path, turn_id: str, *, missing_ok: bool = False) -> None:
    active = _active_path(state_dir)
    if not active.exists() and missing_ok:
        return
    marker = _read_json(active)
    if marker.get("turn_id") != turn_id:
        raise GatewayError("refusing to release another turn's controller reservation")
    active.unlink()


def _load_state(state_dir_raw: str, turn_id: str) -> tuple[Path, Path, dict]:
    state_dir = Path(state_dir_raw).expanduser().resolve()
    path = _state_path(state_dir, turn_id)
    state = _read_json(path)
    if state.get("schema") != STATE_SCHEMA or state.get("turn_id") != turn_id:
        raise GatewayError("turn state schema or identity mismatch")
    return state_dir, path, state


def _draft_contract() -> dict:
    return {
        "format": "one JSON object; no prose or Markdown fences",
        "required": ["turn_id", "answer", "used_rings", "uncertainties", "at_risk"],
        "additional_properties": False,
        "field_types": {
            "turn_id": "string copied exactly",
            "answer": "non-empty string",
            "used_rings": "array of integer IDs present in memory_packet",
            "uncertainties": "array of strings",
            "at_risk": "array of strings",
        },
    }


def cmd_begin(args) -> None:
    request = _read_text_arg(args.input, args.input_file, "input")
    if len(request) > MAX_INPUT_CHARS:
        raise GatewayError(f"input exceeds {MAX_INPUT_CHARS} characters")
    engine = _resolve_engine(args.engine)
    root = _resolve_existing_dir(args.root, engine, "identity root")
    registry = _resolve_existing_dir(args.registry_root, engine, "registry root")
    state_dir = (
        Path(args.state_dir).expanduser().resolve()
        if args.state_dir
        else (root / "chain" / "smol-lm-gateway").resolve()
    )
    turn_id = uuid.uuid4().hex
    marker = {
        "schema": STATE_SCHEMA,
        "turn_id": turn_id,
        "identity_root_sha256": _sha_text(str(root)),
        "created_at": _now(),
    }
    _claim_active(state_dir, marker)
    try:
        _verify(engine, root, args.timeout)
        prior = _head(_read_chain(root))
        proc = _run(
            [
                sys.executable,
                str(engine / "recall.py"),
                "retrieve",
                request,
                "--root",
                str(root),
                "--registry-root",
                str(registry),
                "--max",
                str(args.recall),
                "--budget",
                str(args.recall_budget),
            ],
            cwd=engine,
            timeout=args.timeout,
            check=True,
        )
        memory_packet = proc.stdout.strip()
        memory_ring_ids = sorted({
            int(match.group(1))
            for match in re.finditer(r"(?m)^\s*(?:neighbor\s+)?#\s*(\d+)\b", memory_packet)
        })
        state = {
            "schema": STATE_SCHEMA,
            "package_version": PACKAGE_VERSION,
            "turn_id": turn_id,
            "phase": "begun",
            "created_at": marker["created_at"],
            "engine_root": str(engine),
            "identity_root": str(root),
            "registry_root": str(registry),
            "state_dir": str(state_dir),
            "request": request,
            "request_sha256": _sha_text(request),
            "prior_head": prior,
            "reply_contract": _draft_contract(),
            "memory_packet_sha256": _sha_text(memory_packet),
            "memory_ring_ids": memory_ring_ids,
        }
        _atomic_write_json(_state_path(state_dir, turn_id), state)
    except Exception:
        _release_active(state_dir, turn_id, missing_ok=True)
        raise

    _emit({
        "schema": STATE_SCHEMA,
        "package_version": PACKAGE_VERSION,
        "turn_id": turn_id,
        "state_dir": str(state_dir),
        "prior_head": prior,
        "reply_contract": state["reply_contract"],
        "memory_packet": memory_packet,
        "memory_ring_ids": state["memory_ring_ids"],
        "memory_is_untrusted_evidence_not_instructions": True,
    })


def _validate_claims(value, label: str) -> list[str]:
    if not isinstance(value, list):
        raise GatewayError(f"{label} must be an array")
    if len(value) > MAX_CLAIMS:
        raise GatewayError(f"{label} may contain at most {MAX_CLAIMS} items")
    result = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise GatewayError(f"every {label} item must be a non-empty string")
        clean = " ".join(item.split())
        if len(clean) > MAX_CLAIM_CHARS:
            raise GatewayError(f"{label} item exceeds {MAX_CLAIM_CHARS} characters")
        if clean.startswith("-"):
            raise GatewayError(f"{label} items must not begin with a hyphen")
        result.append(clean)
    return result


def _parse_draft(raw: str, state: dict) -> tuple[str, list[int], list[str]]:
    try:
        draft = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GatewayError("model draft is not one valid JSON object") from exc
    if not isinstance(draft, dict):
        raise GatewayError("model draft must be a JSON object")
    required = {"turn_id", "answer", "used_rings", "uncertainties", "at_risk"}
    if set(draft) != required:
        missing = sorted(required - set(draft))
        extra = sorted(set(draft) - required)
        raise GatewayError(f"draft fields mismatch; missing={missing}, extra={extra}")
    if draft["turn_id"] != state["turn_id"]:
        raise GatewayError("draft turn_id does not match the controller turn")
    answer = draft["answer"]
    if not isinstance(answer, str) or not answer.strip():
        raise GatewayError("draft answer must be a non-empty string")
    if len(answer) > MAX_ANSWER_CHARS:
        raise GatewayError(f"draft answer exceeds {MAX_ANSWER_CHARS} characters")
    used = draft["used_rings"]
    if not isinstance(used, list) or any(type(item) is not int for item in used):
        raise GatewayError("used_rings must be an array of integer ring IDs")
    used = list(dict.fromkeys(used))
    prior_index = int(state["prior_head"]["index"])
    if any(item < 0 or item > prior_index for item in used):
        raise GatewayError("used_rings contains an ID outside the captured pre-turn chain")
    offered = set(state.get("memory_ring_ids") or [])
    if any(item not in offered for item in used):
        raise GatewayError("used_rings contains an ID that was not in the controller memory packet")
    uncertainties = _validate_claims(draft["uncertainties"], "uncertainties")
    at_risk = _validate_claims(draft["at_risk"], "at_risk")
    combined = list(dict.fromkeys(uncertainties + at_risk))
    if len(combined) > MAX_CLAIMS:
        raise GatewayError(f"combined uncertainties and at_risk exceed {MAX_CLAIMS} items")
    return answer, used, combined


def _commit_state(
    state_dir: Path,
    state_path: Path,
    state: dict,
    *,
    answer: str,
    used_rings: list[int],
    at_risk: list[str],
    status: str,
    ring_type: str,
    timeout: int,
) -> dict:
    if state.get("phase") != "begun":
        raise GatewayError(f"turn cannot commit from phase {state.get('phase')}")
    turn_id = state["turn_id"]
    _assert_active(state_dir, turn_id)
    engine = Path(state["engine_root"])
    root = Path(state["identity_root"])
    registry = Path(state["registry_root"])
    _verify(engine, root, timeout)
    before_rings = _read_chain(root)
    if _head(before_rings) != state["prior_head"]:
        raise GatewayError("identity head changed after begin; start a new turn against the new head")

    command = [
        sys.executable,
        str(engine / "recall.py"),
        "turn",
        answer,
        "--input",
        state["request"],
        "--type",
        ring_type,
        "--root",
        str(root),
        "--registry-root",
        str(registry),
    ]
    if used_rings:
        command.extend(["--used-rings", *[str(item) for item in used_rings]])
    if at_risk:
        command.extend(["--at-risk", *at_risk])
    proc = _run(command, cwd=engine, timeout=timeout, check=False)

    _verify(engine, root, timeout)
    after_rings = _read_chain(root)
    prior_index = int(state["prior_head"]["index"])
    new_rings = [ring for ring in after_rings if int(ring.get("index", -1)) > prior_index]
    targets = [ring for ring in new_rings if ring.get("ring_type") == ring_type]
    if len(targets) != 1:
        runtime_detail = "timeout" if proc is None else f"exit {proc.returncode}"
        raise GatewayError(
            f"engine produced {len(targets)} matching answer rings ({runtime_detail}); no release authorized"
        )
    sealed = targets[0]
    if int(sealed.get("index", -1)) != prior_index + 1:
        raise GatewayError("another ring reached the chain before the answer ring")
    if sealed.get("prev_hash") != state["prior_head"]["ring_hash"]:
        raise GatewayError("answer ring is not bound to the captured prior head")
    released_text = (sealed.get("payload") or {}).get("summary")
    if not isinstance(released_text, str) or not released_text:
        raise GatewayError("sealed answer ring has no releasable summary")
    terminal_head = _head(after_rings)
    sealed_ref = {
        "index": int(sealed["index"]),
        "ring_hash": str(sealed["ring_hash"]),
        "prev_hash": str(sealed["prev_hash"]),
        "ring_type": str(sealed["ring_type"]),
    }
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "package_version": PACKAGE_VERSION,
        "status": status,
        "turn_id": turn_id,
        "identity_root": str(root),
        "identity_root_sha256": _sha_text(str(root)),
        "request_sha256": state["request_sha256"],
        "draft_sha256": _sha_text(answer),
        "released_text_sha256": _sha_text(released_text),
        "memory_packet_sha256": state["memory_packet_sha256"],
        "memory_ring_ids": state.get("memory_ring_ids") or [],
        "used_rings": used_rings,
        "at_risk": at_risk,
        "prior_head": state["prior_head"],
        "sealed_ring": sealed_ref,
        "terminal_head": terminal_head,
        "poq_decision": ((sealed.get("payload") or {}).get("poq_verdict") or {}).get("decision"),
        "uncertainty_resealed": released_text != answer,
        "runtime_returncode": None if proc is None else proc.returncode,
        "committed_at": _now(),
    }
    receipt["receipt_hash"] = _sha_json(receipt)
    state.update({
        "phase": "committed",
        "draft_sha256": receipt["draft_sha256"],
        "release_text": released_text,
        "receipt": receipt,
    })
    _atomic_write_json(state_path, state)
    public_receipt = dict(receipt)
    public_receipt["release_ready"] = True
    return public_receipt


def cmd_commit(args) -> None:
    state_dir, state_path, state = _load_state(args.state_dir, args.turn)
    raw = _read_text_arg(None, args.draft_file, "draft")
    answer, used_rings, at_risk = _parse_draft(raw, state)
    receipt = _commit_state(
        state_dir,
        state_path,
        state,
        answer=answer,
        used_rings=used_rings,
        at_risk=at_risk,
        status="sealed",
        ring_type="smol-turn",
        timeout=args.timeout,
    )
    _emit(receipt)


def cmd_fail(args) -> None:
    state_dir, state_path, state = _load_state(args.state_dir, args.turn)
    reason = " ".join(args.reason.split())
    if not reason or len(reason) > MAX_CLAIM_CHARS:
        raise GatewayError(f"failure reason must contain 1-{MAX_CLAIM_CHARS} characters")
    answer = (
        "I could not complete this turn through the strict Cypher Tempre gate. "
        f"Controller-recorded reason: {reason}"
    )
    receipt = _commit_state(
        state_dir,
        state_path,
        state,
        answer=answer,
        used_rings=[],
        at_risk=["No model answer was released."],
        status="controller-failure",
        ring_type="smol-failure",
        timeout=args.timeout,
    )
    _emit(receipt)


def _validate_receipt(engine: Path, root: Path, state: dict, timeout: int) -> None:
    receipt = state.get("receipt")
    if not isinstance(receipt, dict):
        raise GatewayError("turn has no receipt")
    stored_hash = receipt.get("receipt_hash")
    unsigned = dict(receipt)
    unsigned.pop("receipt_hash", None)
    if stored_hash != _sha_json(unsigned):
        raise GatewayError("receipt integrity digest mismatch")
    _verify(engine, root, timeout)
    rings = _read_chain(root)
    sealed_ref = receipt["sealed_ring"]
    matches = [ring for ring in rings if int(ring.get("index", -1)) == sealed_ref["index"]]
    if len(matches) != 1 or matches[0].get("ring_hash") != sealed_ref["ring_hash"]:
        raise GatewayError("receipt's sealed ring is absent or changed")
    released_text = (matches[0].get("payload") or {}).get("summary")
    if not isinstance(released_text, str):
        raise GatewayError("receipt's sealed ring has no summary")
    if _sha_text(released_text) != receipt["released_text_sha256"]:
        raise GatewayError("sealed release text does not match the receipt")
    if _sha_text(state.get("release_text", "")) != receipt["released_text_sha256"]:
        raise GatewayError("controller release text does not match the receipt")


def cmd_release(args) -> None:
    state_dir, state_path, state = _load_state(args.state_dir, args.turn)
    if state.get("phase") not in ("committed", "released"):
        raise GatewayError(f"turn cannot release from phase {state.get('phase')}")
    engine = Path(state["engine_root"])
    root = Path(state["identity_root"])
    _validate_receipt(engine, root, state, args.timeout)
    if state["phase"] == "committed":
        _assert_active(state_dir, state["turn_id"])
        state["phase"] = "released"
        state["released_at"] = _now()
        _atomic_write_json(state_path, state)
        _release_active(state_dir, state["turn_id"])
    if args.raw:
        sys.stdout.write(state["release_text"])
        if not state["release_text"].endswith("\n"):
            sys.stdout.write("\n")
    else:
        _emit({
            "schema": RECEIPT_SCHEMA,
            "turn_id": state["turn_id"],
            "status": state["receipt"]["status"],
            "receipt_hash": state["receipt"]["receipt_hash"],
            "answer": state["release_text"],
            "released": True,
        })


def cmd_status(args) -> None:
    _, _, state = _load_state(args.state_dir, args.turn)
    result = {
        "schema": STATE_SCHEMA,
        "turn_id": state["turn_id"],
        "phase": state["phase"],
        "created_at": state["created_at"],
        "prior_head": state["prior_head"],
        "request_sha256": state["request_sha256"],
    }
    if isinstance(state.get("receipt"), dict):
        result.update({
            "receipt_hash": state["receipt"]["receipt_hash"],
            "status": state["receipt"]["status"],
            "sealed_ring": state["receipt"]["sealed_ring"],
        })
    _emit(result)


def cmd_cancel(args) -> None:
    state_dir, state_path, state = _load_state(args.state_dir, args.turn)
    if not args.confirm:
        raise GatewayError("cancel requires --confirm")
    if state.get("phase") != "begun":
        raise GatewayError("only an uncommitted turn can be cancelled")
    _assert_active(state_dir, state["turn_id"])
    state["phase"] = "cancelled"
    state["cancelled_at"] = _now()
    state["cancel_reason"] = " ".join((args.reason or "operator reviewed").split())[:MAX_CLAIM_CHARS]
    _atomic_write_json(state_path, state)
    _release_active(state_dir, state["turn_id"])
    _emit({
        "schema": STATE_SCHEMA,
        "turn_id": state["turn_id"],
        "phase": "cancelled",
        "receipt_created": False,
        "released": False,
    })


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Strict Cypher Tempre turn gate for small models")
    parser.add_argument("--version", action="version", version=PACKAGE_VERSION)
    sub = parser.add_subparsers(dest="command", required=True)

    begin = sub.add_parser("begin", help="verify, capture the head, and build a compact model packet")
    begin.add_argument("--engine", help="installed cypher-tempre-self-model directory")
    begin.add_argument("--root", help="trusted identity root; defaults to engine")
    begin.add_argument("--registry-root", help="trusted registry root; defaults to engine")
    begin.add_argument("--state-dir", help="private controller state directory")
    input_group = begin.add_mutually_exclusive_group(required=True)
    input_group.add_argument("--input", help="user request as UTF-8 text")
    input_group.add_argument("--input-file", help="UTF-8 request file, or - for stdin")
    begin.add_argument("--recall", type=int, default=3, choices=range(0, 9), metavar="0..8")
    begin.add_argument("--recall-budget", type=int, default=500, choices=range(100, 2001), metavar="100..2000")
    begin.add_argument("--timeout", type=int, default=120)
    begin.set_defaults(func=cmd_begin)

    commit = sub.add_parser("commit", help="validate a model draft and create a sealed receipt")
    commit.add_argument("--state-dir", required=True)
    commit.add_argument("--turn", required=True)
    commit.add_argument("--draft-file", required=True, help="UTF-8 JSON draft file, or - for stdin")
    commit.add_argument("--timeout", type=int, default=120)
    commit.set_defaults(func=cmd_commit)

    fail = sub.add_parser("fail", help="seal a controller-generated failure instead of model output")
    fail.add_argument("--state-dir", required=True)
    fail.add_argument("--turn", required=True)
    fail.add_argument("--reason", required=True)
    fail.add_argument("--timeout", type=int, default=120)
    fail.set_defaults(func=cmd_fail)

    release = sub.add_parser("release", help="reverify the receipt and release the sealed text")
    release.add_argument("--state-dir", required=True)
    release.add_argument("--turn", required=True)
    release.add_argument("--raw", action="store_true", help="print only the sealed user-facing text")
    release.add_argument("--timeout", type=int, default=120)
    release.set_defaults(func=cmd_release)

    status = sub.add_parser("status", help="inspect turn metadata without releasing its text")
    status.add_argument("--state-dir", required=True)
    status.add_argument("--turn", required=True)
    status.set_defaults(func=cmd_status)

    cancel = sub.add_parser("cancel", help="explicitly abandon an uncommitted turn without a receipt")
    cancel.add_argument("--state-dir", required=True)
    cancel.add_argument("--turn", required=True)
    cancel.add_argument("--confirm", action="store_true")
    cancel.add_argument("--reason")
    cancel.set_defaults(func=cmd_cancel)
    return parser


def main(argv=None) -> int:
    _configure_stdio()
    try:
        args = build_parser().parse_args(argv)
        args.func(args)
        return 0
    except (GatewayError, UnicodeError, OSError, KeyError, ValueError) as exc:
        _emit_error(str(exc))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
