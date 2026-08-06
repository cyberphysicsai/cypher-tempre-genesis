#!/usr/bin/env python3
"""Explicit recovery for legacy locale-encoded Cypher Tempre text stores.

The runtime's canonical encoding is UTF-8.  v3.30.04 and earlier omitted an
encoding on several text writers/readers, so Windows could persist cp1252 bytes
such as 0x97 for an em dash.  This tool never repairs anything implicitly:

    python3 encoding_recovery.py inspect PATH
    python3 encoding_recovery.py scan --root ROOT
    python3 encoding_recovery.py recover PATH --confirm
    python3 encoding_recovery.py registry-snapshots --root ROOT --name grown.json
    python3 encoding_recovery.py restore-registry --root ROOT --name grown.json \
      --ring RING --confirm
    # Review PATH and the byte-exact backup, then explicitly re-anchor:
    python3 encoding_recovery.py reanchor --root ROOT \
      --confirm-reviewed --reason "reviewed cp1252-to-UTF-8 recovery"

``recover`` creates a byte-exact sibling backup before decoding or validating,
requires strict source decoding and semantic JSON/JSONL validation, verifies
Timechain hashes when the target is ``rings.jsonl``, writes through an atomic
replacement, and deliberately does not seal or re-anchor anything.  ``reanchor``
is a separate, confirmation-gated human-review step.

Stdlib only. Python 3.8+.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from timechain import GENESIS_PREV, Timechain, compute_ring_hash
from registry_store import (CANONICAL_REGISTRIES, validate_registry_object,
                            validate_registry_set)


SUPPORTED_SUFFIXES = {".json", ".jsonl"}


class RecoveryError(RuntimeError):
    """The requested recovery cannot be proven safe."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _jsonl_records(text: str) -> list:
    records = []
    # JSONL uses a physical LF delimiter.  str.splitlines() would also split on
    # U+2028/U+2029 occurring inside a valid JSON string.
    for physical_line, line in enumerate(text.split("\n"), 1):
        if line.endswith("\r"):
            line = line[:-1]
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise RecoveryError(
                f"invalid JSONL at physical line {physical_line}: {exc}"
            ) from exc
    return records


def _validate_ring_records(records: list) -> None:
    prev_hash = GENESIS_PREV
    for expected_index, ring in enumerate(records):
        if not isinstance(ring, dict):
            raise RecoveryError(f"ring {expected_index} is not a JSON object")
        if ring.get("index") != expected_index:
            raise RecoveryError(
                f"ring index mismatch: expected {expected_index}, got {ring.get('index')}"
            )
        if ring.get("prev_hash") != prev_hash:
            raise RecoveryError(f"ring {expected_index} has a broken prev_hash")
        recomputed = compute_ring_hash(ring)
        if recomputed != ring.get("ring_hash"):
            raise RecoveryError(
                f"ring {expected_index} hash mismatch before recovery; refusing to rewrite"
            )
        prev_hash = ring["ring_hash"]


def validate_semantics(path: Path, text: str):
    """Parse a supported store and return a comparison-safe semantic value."""
    path = Path(path)
    if path.suffix not in SUPPORTED_SUFFIXES:
        raise RecoveryError(
            f"unsupported store type {path.suffix!r}; only .json and .jsonl are recoverable"
        )
    if path.suffix == ".json":
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise RecoveryError(f"invalid JSON: {exc}") from exc
    records = _jsonl_records(text)
    if path.name == "rings.jsonl":
        _validate_ring_records(records)
    return records


def inspect_path(path: Path, source_encoding: str = "cp1252") -> dict:
    """Read-only encoding and semantic validation."""
    path = Path(path).expanduser()
    if path.is_symlink():
        raise RecoveryError(f"target must not be a symlink: {path}")
    path = path.resolve()
    if not path.is_file():
        raise RecoveryError(f"target must be a regular file: {path}")
    raw = path.read_bytes()
    result = {"path": str(path), "size": len(raw), "sha256": _sha256(raw)}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as utf8_error:
        result["utf8"] = False
        result["utf8_error_byte"] = utf8_error.start
    else:
        validate_semantics(path, text)
        result.update({"utf8": True, "status": "already-valid-utf8", "recoverable": False})
        return result

    try:
        legacy_text = raw.decode(source_encoding)
    except UnicodeDecodeError as exc:
        raise RecoveryError(f"strict {source_encoding} decoding failed: {exc}") from exc
    validate_semantics(path, legacy_text)
    result.update({
        "status": f"recoverable-{source_encoding}",
        "recoverable": True,
        "source_encoding": source_encoding,
    })
    return result


def _backup_stem(path: Path) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{path.name}.pre-utf8-{stamp}"


def _create_verified_backup(path: Path, raw: bytes) -> Path:
    """Create a byte-exact backup with O_EXCL so nothing is ever overwritten."""
    stem = _backup_stem(path)
    for serial in range(10000):
        suffix = "" if serial == 0 else f"-{serial}"
        candidate = path.with_name(f"{stem}{suffix}.bak")
        try:
            fd = os.open(str(candidate), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(raw)
                fh.flush()
                os.fsync(fh.fileno())
            shutil.copystat(str(path), str(candidate))
        except Exception:
            # Keep any partial backup as evidence; O_EXCL guarantees we did not
            # clobber a pre-existing file.
            raise
        if candidate.read_bytes() != raw:
            raise RecoveryError(f"backup verification failed: {candidate}")
        return candidate
    raise RecoveryError("could not allocate a unique backup path")


def recover_path(path: Path, source_encoding: str = "cp1252",
                 confirmed: bool = False) -> dict:
    """Back up, validate, and atomically transcode one exact store to UTF-8."""
    if not confirmed:
        raise RecoveryError("recovery is write-capable; rerun with --confirm")
    path = Path(path).expanduser()
    if path.is_symlink():
        raise RecoveryError(f"target must not be a symlink: {path}")
    path = path.resolve()
    if not path.is_file():
        raise RecoveryError(f"target must be a regular file: {path}")
    raw = path.read_bytes()
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    else:
        raise RecoveryError("target is already valid UTF-8; no recovery performed")

    # Backup first, before decoding or semantic validation.  A failed validation
    # leaves the original untouched and the byte-exact evidence preserved.
    backup = _create_verified_backup(path, raw)

    try:
        text = raw.decode(source_encoding)
    except UnicodeDecodeError as exc:
        raise RecoveryError(
            f"backup created at {backup}, but strict {source_encoding} decoding failed: {exc}"
        ) from exc
    semantic_before = validate_semantics(path, text)
    converted = text.encode("utf-8")
    semantic_after = validate_semantics(path, converted.decode("utf-8"))
    if semantic_before != semantic_after:
        raise RecoveryError(
            f"backup created at {backup}, but semantic comparison failed; original untouched"
        )

    tmp = None
    try:
        with tempfile.NamedTemporaryFile(
                mode="wb", prefix=f"{path.name}.", suffix=".utf8.tmp",
                dir=str(path.parent), delete=False) as fh:
            tmp = Path(fh.name)
            fh.write(converted)
            fh.flush()
            os.fsync(fh.fileno())
        shutil.copymode(str(path), str(tmp))
        tmp.replace(path)
    finally:
        if tmp is not None and tmp.exists():
            tmp.unlink()

    # The replacement bytes were already validated before the atomic rename;
    # re-read them so the receipt proves what is now on disk.
    final = path.read_bytes()
    validate_semantics(path, final.decode("utf-8"))
    receipt = {
        "path": str(path),
        "backup": str(backup),
        "source_encoding": source_encoding,
        "before_sha256": _sha256(raw),
        "after_sha256": _sha256(final),
        "semantic_validation": "pass",
        "reanchored": False,
    }
    if path.parent.name == "registry":
        receipt["next_step"] = (
            "review the converted file and backup, then run: "
            "python3 encoding_recovery.py reanchor --root "
            f"{shlex.quote(str(path.parent.parent))} "
            "--confirm-reviewed --reason 'reviewed cp1252-to-UTF-8 recovery'"
        )
    return receipt


def scan_root(root: Path) -> list:
    """Read-only scan of active managed JSON/JSONL stores below one exact root.

    Quarantine holds deliberately inactive forensic artifacts; those bytes must
    remain untouched and must not block validation or registry re-anchoring.
    Operators can still inspect or recover one exact quarantined path directly.
    """
    root = Path(root).expanduser().resolve()
    if not root.is_dir():
        raise RecoveryError(f"root is not a directory: {root}")
    candidates = sorted(set(root.rglob("*.json")) | set(root.rglob("*.jsonl")))
    results = []
    for path in candidates:
        relative = path.relative_to(root)
        if "quarantine" in relative.parts:
            continue
        if path.is_symlink() or not path.is_file():
            continue
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            results.append({"path": str(path), "utf8": False,
                            "semantic_valid": False, "error_byte": exc.start})
        else:
            try:
                validate_semantics(path, text)
            except RecoveryError as exc:
                results.append({"path": str(path), "utf8": True,
                                "semantic_valid": False, "error": str(exc)})
            else:
                results.append({"path": str(path), "utf8": True,
                                "semantic_valid": True})
    return results


def reanchor_after_review(root: Path, reason: str,
                          confirmed_reviewed: bool = False):
    """Explicit second phase: seal reviewed registry bytes into a new epoch."""
    if not confirmed_reviewed:
        raise RecoveryError("re-anchor requires --confirm-reviewed after human review")
    invalid = [r for r in scan_root(root)
               if not r["utf8"] or not r["semantic_valid"]]
    if invalid:
        raise RecoveryError(
            f"refusing to re-anchor while invalid stores remain: {invalid[0]['path']}"
        )
    try:
        validate_registry_set(Path(root))
    except Exception as exc:
        raise RecoveryError(f"refusing to re-anchor an invalid registry: {exc}") from exc
    import epochs
    return epochs.seal_epoch(Path(root), reason=reason, accept_current=True)


def _verified_timechain(root: Path) -> Timechain:
    tc = Timechain(Path(root).expanduser().resolve())
    ok, report = tc.verify()
    if not ok:
        raise RecoveryError(
            "Timechain or blockspace verification failed; refusing recovery: "
            + " | ".join(report[:3]))
    return tc


def _registry_snapshot(tc: Timechain, name: str, ring_index: int):
    if name not in CANONICAL_REGISTRIES:
        raise RecoveryError(f"unsupported canonical registry: {name}")
    match = None
    for ring in tc.iter_rings():
        if ring.get("index") != ring_index:
            continue
        refs = [ref for ref in ring.get("blockspace_refs", [])
                if ref.get("role") in (name, f"registry/{name}")]
        if len(refs) != 1:
            raise RecoveryError(
                f"ring {ring_index} contains {len(refs)} snapshots for {name}; expected exactly one")
        match = (ring, refs[0])
        break
    if match is None:
        raise RecoveryError(f"ring {ring_index} does not exist")
    ring, ref = match
    digest = ref.get("hash")
    if not isinstance(digest, str) or not tc.blockspace.verify_blob(digest):
        raise RecoveryError(f"ring {ring_index} references a missing or corrupt blockspace blob")
    return ring, ref, tc.blockspace.get(digest)


def _decode_registry_snapshot(name: str, raw: bytes, source_encoding: str,
                              display_path: Path):
    try:
        text = raw.decode("utf-8")
        used = "utf-8"
    except UnicodeDecodeError:
        try:
            text = raw.decode(source_encoding)
            used = source_encoding
        except UnicodeDecodeError as exc:
            raise RecoveryError(
                f"snapshot is neither strict UTF-8 nor strict {source_encoding}: {exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RecoveryError(f"snapshot JSON is malformed: {exc}") from exc
    try:
        validate_registry_object(name, data, display_path)
    except Exception as exc:
        raise RecoveryError(f"snapshot registry schema is invalid: {exc}") from exc
    return data, used


def list_registry_snapshots(root: Path, name: str,
                            source_encoding: str = "cp1252") -> list:
    """List chain-attached snapshots, including schema/encoding validity."""
    tc = _verified_timechain(root)
    rows, seen = [], set()
    for ring in tc.iter_rings():
        for ref in ring.get("blockspace_refs", []):
            if ref.get("role") not in (name, f"registry/{name}"):
                continue
            digest = ref.get("hash")
            key = (ring.get("index"), digest)
            if key in seen:
                continue
            seen.add(key)
            row = {"ring": ring.get("index"), "ring_type": ring.get("ring_type"),
                   "timestamp": ring.get("timestamp"), "hash": digest}
            try:
                if not isinstance(digest, str) or not tc.blockspace.verify_blob(digest):
                    raise RecoveryError("missing or corrupt blockspace blob")
                data, used = _decode_registry_snapshot(
                    name, tc.blockspace.get(digest), source_encoding,
                    Path(root) / "registry" / name)
                row.update({"valid": True, "encoding": used})
                if name == "grown.json":
                    row["modalities"] = len(data["modalities"])
                    row["senses"] = len(data["senses"])
            except RecoveryError as exc:
                row.update({"valid": False, "error": str(exc)})
            rows.append(row)
    return rows


def restore_registry_snapshot(root: Path, name: str, ring_index: int,
                              source_encoding: str = "cp1252",
                              confirmed: bool = False) -> dict:
    """Backup the live registry, then restore one reviewed blockspace snapshot."""
    if not confirmed:
        raise RecoveryError("registry restore is write-capable; rerun with --confirm")
    root = Path(root).expanduser().resolve()
    target = root / "registry" / name
    if target.is_symlink():
        raise RecoveryError(f"target must not be a symlink: {target}")
    if not target.is_file():
        raise RecoveryError(
            f"target must already be a regular file so it can be backed up first: {target}")

    tc = _verified_timechain(root)
    ring, ref, snapshot_raw = _registry_snapshot(tc, name, int(ring_index))

    # Preserve current evidence before interpreting the candidate snapshot.
    current_raw = target.read_bytes()
    backup = _create_verified_backup(target, current_raw)
    try:
        data, used = _decode_registry_snapshot(name, snapshot_raw, source_encoding, target)
    except RecoveryError as exc:
        raise RecoveryError(f"backup created at {backup}, but restore refused: {exc}") from exc

    converted = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
    # Re-parse the exact candidate bytes before replacement.
    try:
        validate_registry_object(name, json.loads(converted.decode("utf-8")), target)
    except Exception as exc:
        raise RecoveryError(
            f"backup created at {backup}, but canonical UTF-8 validation failed: {exc}") from exc

    tmp = None
    try:
        with tempfile.NamedTemporaryFile(
                mode="wb", prefix=f"{target.name}.", suffix=".restore.tmp",
                dir=str(target.parent), delete=False) as fh:
            tmp = Path(fh.name)
            fh.write(converted)
            fh.flush()
            os.fsync(fh.fileno())
        shutil.copymode(str(target), str(tmp))
        tmp.replace(target)
    finally:
        if tmp is not None and tmp.exists():
            tmp.unlink()

    try:
        validate_registry_object(name, json.loads(target.read_text(encoding="utf-8")), target)
    except Exception as exc:
        raise RecoveryError(
            f"restore replacement failed final validation; recover from backup {backup}: {exc}") from exc
    return {
        "path": str(target), "backup": str(backup), "source_ring": ring["index"],
        "source_ring_type": ring.get("ring_type"), "source_blob": ref["hash"],
        "source_encoding": used, "before_sha256": _sha256(current_raw),
        "after_sha256": _sha256(target.read_bytes()), "semantic_validation": "pass",
        "schema_validation": "pass", "reanchored": False,
        "next_step": (
            "review the restored file and backup, then run: "
            f"python3 encoding_recovery.py reanchor --root {shlex.quote(str(root))} "
            "--confirm-reviewed --reason 'reviewed blockspace registry recovery'")
    }


def _print_json(obj) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Inspect or explicitly recover legacy cp1252 JSON/JSONL stores")
    sub = parser.add_subparsers(dest="command", required=True)

    inspect_p = sub.add_parser("inspect", help="read-only inspection of one exact file")
    inspect_p.add_argument("path")
    inspect_p.add_argument("--from-encoding", choices=("cp1252",), default="cp1252")

    scan_p = sub.add_parser("scan", help="read-only UTF-8 scan below one root")
    scan_p.add_argument("--root", required=True)

    recover_p = sub.add_parser("recover", help="backup and transcode one exact file")
    recover_p.add_argument("path")
    recover_p.add_argument("--from-encoding", choices=("cp1252",), default="cp1252")
    recover_p.add_argument("--confirm", action="store_true")

    reanchor_p = sub.add_parser("reanchor", help="seal reviewed registry bytes")
    reanchor_p.add_argument("--root", required=True)
    reanchor_p.add_argument("--reason", required=True)
    reanchor_p.add_argument("--confirm-reviewed", action="store_true")

    snapshots_p = sub.add_parser(
        "registry-snapshots", help="list verified blockspace snapshots for one registry")
    snapshots_p.add_argument("--root", required=True)
    snapshots_p.add_argument("--name", choices=CANONICAL_REGISTRIES, default="grown.json")
    snapshots_p.add_argument("--from-encoding", choices=("cp1252",), default="cp1252")

    restore_p = sub.add_parser(
        "restore-registry", help="backup live registry and restore one reviewed snapshot")
    restore_p.add_argument("--root", required=True)
    restore_p.add_argument("--name", choices=CANONICAL_REGISTRIES, default="grown.json")
    restore_p.add_argument("--ring", required=True, type=int)
    restore_p.add_argument("--from-encoding", choices=("cp1252",), default="cp1252")
    restore_p.add_argument("--confirm", action="store_true")

    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            _print_json(inspect_path(args.path, args.from_encoding))
        elif args.command == "scan":
            results = scan_root(args.root)
            _print_json({"root": str(Path(args.root).expanduser().resolve()),
                         "files": len(results),
                         "invalid_utf8": sum(not r["utf8"] for r in results),
                         "invalid_semantics": sum(not r["semantic_valid"] for r in results),
                         "results": results})
            return 2 if any(not r["utf8"] or not r["semantic_valid"]
                            for r in results) else 0
        elif args.command == "recover":
            _print_json(recover_path(args.path, args.from_encoding, args.confirm))
        elif args.command == "reanchor":
            ring = reanchor_after_review(args.root, args.reason, args.confirm_reviewed)
            if ring is None:
                print("no change — registries already match the latest epoch")
            else:
                print(f"sealed reviewed registry epoch Ring {ring['index']}  "
                      f"{ring['ring_hash'][:16]}..")
        elif args.command == "registry-snapshots":
            rows = list_registry_snapshots(args.root, args.name, args.from_encoding)
            _print_json({"root": str(Path(args.root).expanduser().resolve()),
                         "registry": args.name, "snapshots": rows})
            return 0 if rows else 2
        else:
            _print_json(restore_registry_snapshot(
                args.root, args.name, args.ring, args.from_encoding, args.confirm))
    except (OSError, RecoveryError, UnicodeError, ValueError) as exc:
        print(f"RECOVERY REFUSED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
