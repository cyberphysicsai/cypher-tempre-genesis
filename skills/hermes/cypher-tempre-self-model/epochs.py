#!/usr/bin/env python3
"""
Registry Epochs — close the unauthenticated write surface (v3.12).

FINDING (2026-07-03 self-audit, Ring 1414): the registries (senses.json,
modalities.json, grown.json, grown_ops.json) are mutable files OUTSIDE the hash
chain. Only genesis snapshots them. A tampered grown_ops.json — which compiles
into executable ops the loop runs every turn — passed `timechain.py verify`
untouched. That is arbitrary-behavior injection under a verified-green banner.

FIX: every registry mutation seals a small `epoch` ring anchoring the
content-hash of each registry file into the chain (and the full content into
blockspace). Verification then recomputes the live registry hashes and compares
them against the latest epoch ring: a mismatch is TAMPERING, reported exactly
like a broken ring hash.

Commands:
    python3 epochs.py seal    [--root R]   # seal a new registry epoch ring now
    python3 epochs.py check   [--root R]   # live registries vs latest epoch
    python3 epochs.py status  [--root R]   # latest epoch summary

Library:
    begin_mutation(root)       -> authorization ticket (refuses a dirty baseline)
    commit_mutation(root, ticket, reason) -> ring | None
    seal_epoch(root, reason)   -> ring | None (manual/first-anchor path)
    check_epoch(root)          -> (ok: bool, report: [str])

Stdlib only. Python 3.8+. Fail-open on missing chain (a fresh install has no
epochs yet); fail-CLOSED on hash mismatch.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from timechain import Timechain

REGISTRY_FILES = ("senses.json", "modalities.json", "grown.json",
                  "grown_ops.json", "emergent.json")


class EpochMismatchError(RuntimeError):
    """A registry differs from the last authenticated epoch."""


def _registry_dir(root: Path) -> Path:
    return Path(root) / "registry"


def registry_hashes(root: Path) -> dict:
    """Stable content-hash per registry file (sha256 of canonical JSON when the
    file parses, of raw bytes otherwise, so a corrupted file still hashes)."""
    out = {}
    rdir = _registry_dir(root)
    for name in REGISTRY_FILES:
        p = rdir / name
        if not p.exists():
            out[name] = None
            continue
        raw = p.read_bytes()
        try:
            canon = json.dumps(json.loads(raw), sort_keys=True,
                               separators=(",", ":")).encode()
        except Exception:
            canon = raw
        out[name] = hashlib.sha256(canon).hexdigest()
    return out


def latest_epoch(tc: Timechain):
    """Newest epoch ring, or None. Streams backward-cheap: reads the file once."""
    latest = None
    for ring in tc.iter_rings() if hasattr(tc, "iter_rings") else _iter(tc):
        if ring.get("ring_type") == "epoch":
            latest = ring
    return latest


def _iter(tc: Timechain):
    path = tc.rings_path
    if not path.exists():
        return
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except Exception:
                    continue


def _seal_snapshot(root: Path, hashes: dict, reason: str):
    tc = Timechain(root)
    files = [str(_registry_dir(root) / n) for n in REGISTRY_FILES
             if (_registry_dir(root) / n).exists()]
    return tc.seal("epoch", {
        "summary": f"registry epoch: {reason}",
        "registry_hashes": hashes,
    }, files=files)


def begin_mutation(root: Path):
    """Authorize one known registry mutation from a verified baseline.

    The old post-write-only API could not distinguish a legitimate mutation
    from attacker-injected content: any hot path simply snapshotted whatever
    was on disk and made a tamper alarm self-clear. This preflight validates the
    live registry *before* the caller writes and returns a ticket binding the
    later commit to that exact authenticated epoch.
    """
    root = Path(root)
    tc = Timechain(root)
    live = registry_hashes(root)
    prev = latest_epoch(tc)
    if prev is not None:
        sealed = (prev.get("payload") or {}).get("registry_hashes") or {}
        if sealed != live:
            raise EpochMismatchError(
                f"registry differs from epoch ring {prev['index']}; refusing to "
                "authorize a mutation over a compromised/unreviewed baseline"
            )
    elif tc.rings_path.exists() and tc.load():
        # First protected mutation on a lived chain: authenticate the baseline
        # before anything changes, then bind the ticket to that ring.
        prev = _seal_snapshot(root, live, "pre-mutation baseline")
    return {
        "registry_hashes": live,
        "epoch_ring_hash": prev.get("ring_hash") if prev else None,
        "anchored": prev is not None,
    }


def seal_epoch(root: Path, reason: str = "registry mutation",
               expected_previous=None, accept_current: bool = False):
    """Seal current registry hashes without laundering an existing mismatch.

    - unchanged state is an idempotent no-op;
    - automatic callers pass a ticket from :func:`begin_mutation`;
    - a manual re-anchor after human review requires ``accept_current=True``.
    """
    root = Path(root)
    tc = Timechain(root)
    hashes = registry_hashes(root)
    prev = latest_epoch(tc)
    sealed = (prev.get("payload") or {}).get("registry_hashes") if prev else None
    if prev and sealed == hashes:
        return None
    if expected_previous is not None:
        expected_hashes = expected_previous.get("registry_hashes") or {}
        expected_ring = expected_previous.get("epoch_ring_hash")
        if expected_previous.get("anchored"):
            if prev is None or prev.get("ring_hash") != expected_ring or sealed != expected_hashes:
                raise EpochMismatchError(
                    "registry epoch changed after mutation authorization; refusing to seal"
                )
        elif prev is not None and sealed != expected_hashes:
            raise EpochMismatchError(
                "an epoch appeared after an unanchored mutation authorization; refusing to seal"
            )
        return _seal_snapshot(root, hashes, reason)
    if prev is not None and not accept_current:
        raise EpochMismatchError(
            f"registry differs from epoch ring {prev['index']}; refusing to bless current "
            "content automatically (inspect it, then rerun with --accept-current)"
        )
    return _seal_snapshot(root, hashes, reason)


def commit_mutation(root: Path, ticket, reason: str = "registry mutation"):
    return seal_epoch(root, reason=reason, expected_previous=ticket)


def check_epoch(root: Path):
    """Compare live registry hashes against the latest sealed epoch.
    ok=True with a note when no epoch exists yet (pre-3.12 chain)."""
    root = Path(root)
    tc = Timechain(root)
    prev = latest_epoch(tc)
    if prev is None:
        return True, ["no registry epoch sealed yet (pre-3.12 chain) — "
                      "run: python3 epochs.py seal"]
    sealed = (prev.get("payload") or {}).get("registry_hashes") or {}
    live = registry_hashes(root)
    report, ok = [], True
    for name in REGISTRY_FILES:
        if sealed.get(name) != live.get(name):
            ok = False
            report.append(f"registry {name}: hash mismatch vs epoch ring "
                          f"{prev['index']} -> TAMPERED or unsealed mutation")
    if ok:
        report.append(f"registries match epoch ring {prev['index']} "
                      f"({prev['timestamp'][:19]})")
    return ok, report


def cmd_seal(args):
    try:
        ring = seal_epoch(args.root, reason=args.reason,
                          accept_current=args.accept_current)
    except EpochMismatchError as exc:
        print(f"EPOCH SEAL REFUSED: {exc}")
        sys.exit(1)
    if ring is None:
        print("no change — registries already match the latest epoch")
    else:
        print(f"sealed epoch Ring {ring['index']}  {ring['ring_hash'][:16]}..")


def cmd_check(args):
    ok, report = check_epoch(args.root)
    for line in report:
        print(("  " if ok else "  ! ") + line)
    print("EPOCH CHECK: PASS" if ok else "EPOCH CHECK: FAIL — registries do not "
          "match their sealed epoch. Treat as compromise: inspect, then reseal "
          "deliberately if the mutation was yours.")
    sys.exit(0 if ok else 1)


def cmd_status(args):
    tc = Timechain(Path(args.root))
    prev = latest_epoch(tc)
    if prev is None:
        print("no epoch rings yet")
        return
    h = (prev.get("payload") or {}).get("registry_hashes") or {}
    print(f"latest epoch: ring {prev['index']}  {prev['timestamp'][:19]}")
    for k, v in h.items():
        print(f"  {k:<18} {str(v)[:16]}")


def main():
    default_root = Path(__file__).parent
    # The subparser copy uses SUPPRESS so `epochs.py --root R status` is not
    # overwritten by a second default while `epochs.py status --root R` remains
    # accepted. v3.30.03 silently discarded the first form.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", type=Path, default=argparse.SUPPRESS)
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--root", type=Path, default=default_root)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("seal", parents=[common]); s.add_argument("--reason", default="manual seal")
    s.add_argument("--accept-current", action="store_true",
                   help="after human review, deliberately replace a mismatched epoch anchor")
    s.set_defaults(func=cmd_seal)
    c = sub.add_parser("check", parents=[common]); c.set_defaults(func=cmd_check)
    st = sub.add_parser("status", parents=[common]); st.set_defaults(func=cmd_status)
    args = ap.parse_args()
    args.root = Path(args.root)
    args.func(args)


if __name__ == "__main__":
    main()
