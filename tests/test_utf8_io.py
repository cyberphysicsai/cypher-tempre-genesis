#!/usr/bin/env python3
"""UTF-8 persistence and legacy cp1252 recovery regressions (v3.30.05).

Runs standalone on every platform and under pytest.  The subprocess case turns
Python's UTF-8 mode and locale coercion off, so the same test exercises an ASCII
locale on Unix and the native legacy codepage on Windows.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / "skills" / "claude" / "cypher-tempre-self-model"
BUNDLES = [REPO / "skills" / name / "cypher-tempre-self-model"
           for name in ("claude", "codex", "hermes", "nanoclaw", "openclaw")]
sys.path.insert(0, str(SKILL))

import encoding_recovery  # noqa: E402
import epochs  # noqa: E402
import timechain  # noqa: E402


RESULTS = []


def check(name, condition, detail=""):
    ok = bool(condition)
    RESULTS.append((name, ok, detail))
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"  {detail}" if detail and not ok else ""))


def _missing_runtime_encodings():
    """Return text-file calls that still rely on the host locale."""
    rows = []
    file_keywords = {"mode", "buffering", "encoding", "errors", "newline",
                     "closefd", "opener"}
    for bundle in BUNDLES:
        for path in sorted(bundle.rglob("*.py")):
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                kind = None
                mode_node = None
                if isinstance(node.func, ast.Attribute) and node.func.attr in {
                        "read_text", "write_text"}:
                    kind = node.func.attr
                elif isinstance(node.func, ast.Name) and node.func.id == "open":
                    kind = "open"
                    mode_node = node.args[1] if len(node.args) > 1 else None
                elif isinstance(node.func, ast.Attribute) and node.func.attr == "open":
                    if isinstance(node.func.value, ast.Name) and node.func.value.id == "os":
                        continue  # low-level descriptor API; no text encoding exists
                    # Domain methods such as Audit.open(objective=...) are not file I/O.
                    if ({kw.arg for kw in node.keywords if kw.arg} - file_keywords):
                        continue
                    kind = "open"
                    mode_node = node.args[0] if node.args else None
                if not kind or any(kw.arg == "encoding" for kw in node.keywords):
                    continue
                if kind == "open":
                    for kw in node.keywords:
                        if kw.arg == "mode":
                            mode_node = kw.value
                    if (isinstance(mode_node, ast.Constant)
                            and isinstance(mode_node.value, str)
                            and "b" in mode_node.value):
                        continue
                rows.append(f"{path.relative_to(REPO)}:{node.lineno}:{kind}")
    return rows


def test_runtime_io_audit():
    missing = _missing_runtime_encodings()
    check("UTF-8 audit: every runtime text-file call declares encoding",
          not missing, ", ".join(missing[:5]))


def test_atomic_json_exact_bytes():
    with tempfile.TemporaryDirectory(prefix="ct-utf8-atomic-") as td:
        path = Path(td) / "grown.json"
        timechain.atomic_write_json(path, {"function": "sense — data-facing gap"})
        raw = path.read_bytes()
        check("atomic JSON: em dash is exact UTF-8 E2 80 94",
              b"\xe2\x80\x94" in raw and b"\x97" not in raw)
        check("atomic JSON: strict UTF-8 reader succeeds",
              json.loads(raw.decode("utf-8"))["function"].startswith("sense"))


def _make_nonascii_chain(root: Path):
    tc = timechain.Timechain(root)
    tc.CHECKPOINT_EVERY = 1
    tc.genesis(name="UTF-8 verifier")
    tc.seal("experience", {"summary": "faculty — data-facing perceptual gap"})
    return tc


def test_nonascii_full_and_fast_verify():
    with tempfile.TemporaryDirectory(prefix="ct-utf8-chain-") as td:
        tc = _make_nonascii_chain(Path(td))
        full_ok, full_report = tc.verify()
        fast_ok, fast_report = tc.verify_fast()
        check("Timechain: full verify accepts non-ASCII UTF-8 rings",
              full_ok, " | ".join(full_report))
        check("Timechain: fast verify accepts non-ASCII UTF-8 rings",
              fast_ok, " | ".join(fast_report))
        raw = tc.rings_path.read_bytes()
        check("Timechain: JSONL stores the UTF-8 em dash bytes",
              b"\xe2\x80\x94" in raw and b"\x97" not in raw)


def test_locale_independent_subprocess():
    with tempfile.TemporaryDirectory(prefix="ct-utf8-locale-") as td:
        code = (
            "import sys; from pathlib import Path; "
            f"sys.path.insert(0, {str(SKILL)!r}); "
            "from timechain import Timechain; "
            "t=Timechain(Path(sys.argv[1])); t.CHECKPOINT_EVERY=1; "
            "t.genesis(name='Windows codepage'); "
            "t.seal('experience', {'summary':'faculty \\u2014 perceptual gap'}); "
            "assert t.verify()[0] and t.verify_fast()[0]; "
            "assert b'\\xe2\\x80\\x94' in t.rings_path.read_bytes()"
        )
        env = os.environ.copy()
        env.update({"PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0", "LC_ALL": "C"})
        proc = subprocess.run(
            [sys.executable, "-c", code, td], capture_output=True,
            encoding="utf-8", errors="replace", env=env, timeout=60)
        check("cross-locale subprocess: UTF-8 mode off still writes/verifies UTF-8",
              proc.returncode == 0, proc.stdout + proc.stderr)


def test_invalid_cp1252_chain_is_encoding_error():
    with tempfile.TemporaryDirectory(prefix="ct-cp1252-chain-") as td:
        tc = _make_nonascii_chain(Path(td))
        text = tc.rings_path.read_bytes().decode("utf-8")
        tc.rings_path.write_bytes(text.encode("cp1252"))
        full_ok, full_report = tc.verify()
        fast_ok, fast_report = tc.verify_fast()
        combined = " | ".join(full_report + fast_report)
        check("legacy chain: full and fast verification fail closed",
              not full_ok and not fast_ok)
        check("legacy chain: failure names invalid UTF-8, not a hash mismatch",
              "invalid UTF-8" in combined and "ring_hash mismatch" not in combined,
              combined)
        try:
            tc.load()
        except timechain.StorageEncodingError:
            load_refused = True
        else:
            load_refused = False
        check("legacy chain: ordinary readers refuse with StorageEncodingError",
              load_refused)


def test_explicit_recovery_and_reviewed_reanchor():
    with tempfile.TemporaryDirectory(prefix="ct-cp1252-recovery-") as td:
        root = Path(td)
        registry = root / "registry"
        registry.mkdir()
        target = registry / "grown.json"
        intended = {"registry": "grown", "senses": [], "modalities": [
            {"id": 22, "name": "Legacy", "function": "sense — data-facing gap",
             "category": "structural"}]}
        legacy = json.dumps(intended, ensure_ascii=False, indent=2).encode("cp1252")
        target.write_bytes(legacy)

        tc = timechain.Timechain(root)
        tc.genesis(name="recovery test")
        tc.seal("epoch", {"summary": "legacy baseline",
                          "registry_hashes": epochs.registry_hashes(root)}, files=[str(target)])
        head_before = tc._tail_ring()["ring_hash"]

        inspection = encoding_recovery.inspect_path(target)
        check("recovery inspect: cp1252 store is recoverable and unchanged",
              inspection["recoverable"] and target.read_bytes() == legacy)
        try:
            encoding_recovery.recover_path(target)
        except encoding_recovery.RecoveryError:
            unconfirmed_refused = True
        else:
            unconfirmed_refused = False
        check("recovery: conversion refuses without confirmation",
              unconfirmed_refused and not list(registry.glob("*.bak")))

        receipt = encoding_recovery.recover_path(target, confirmed=True)
        backup = Path(receipt["backup"])
        check("recovery: byte-exact backup is created first",
              backup.read_bytes() == legacy)
        check("recovery: converted registry is valid semantic UTF-8",
              json.loads(target.read_text(encoding="utf-8")) == intended
              and b"\xe2\x80\x94" in target.read_bytes())
        check("recovery: conversion never seals or auto-reanchors",
              tc._tail_ring()["ring_hash"] == head_before
              and epochs.check_epoch(root)[0] is False)

        try:
            encoding_recovery.reanchor_after_review(root, "not reviewed")
        except encoding_recovery.RecoveryError:
            reanchor_refused = True
        else:
            reanchor_refused = False
        check("recovery: re-anchor refuses without reviewed confirmation",
              reanchor_refused and epochs.check_epoch(root)[0] is False)
        ring = encoding_recovery.reanchor_after_review(
            root, "reviewed cp1252-to-UTF-8 recovery", confirmed_reviewed=True)
        check("recovery: reviewed re-anchor seals a new epoch",
              ring is not None and epochs.check_epoch(root)[0] is True)


def test_backup_precedes_semantic_refusal():
    with tempfile.TemporaryDirectory(prefix="ct-cp1252-invalid-") as td:
        target = Path(td) / "invalid.json"
        legacy = b'{"message":"bad \x97 dash"'
        target.write_bytes(legacy)
        try:
            encoding_recovery.recover_path(target, confirmed=True)
        except encoding_recovery.RecoveryError:
            refused = True
        else:
            refused = False
        backups = list(target.parent.glob("invalid.json.pre-utf8-*.bak"))
        check("recovery: invalid JSON is refused without touching original",
              refused and target.read_bytes() == legacy)
        check("recovery: refusal still preserves the byte-exact backup",
              len(backups) == 1 and backups[0].read_bytes() == legacy)


def test_recovery_scan_ignores_inactive_quarantine():
    with tempfile.TemporaryDirectory(prefix="ct-recovery-scan-") as td:
        root = Path(td)
        active = root / "registry" / "grown.json"
        inactive = root / "chain" / "quarantine" / "forensic.jsonl"
        active.parent.mkdir(parents=True)
        inactive.parent.mkdir(parents=True)
        active.write_bytes('{"faculty":"meaning — intact"}\n'.encode("utf-8"))
        inactive.write_bytes(b"{'deliberately': 'non-json forensic bytes'}\n")

        results = encoding_recovery.scan_root(root)
        check("recovery scan: inactive quarantine does not block active-store review",
              len(results) == 1 and results[0]["path"] == str(active.resolve())
              and results[0]["semantic_valid"])


def main():
    for test in (
        test_runtime_io_audit,
        test_atomic_json_exact_bytes,
        test_nonascii_full_and_fast_verify,
        test_locale_independent_subprocess,
        test_invalid_cp1252_chain_is_encoding_error,
        test_explicit_recovery_and_reviewed_reanchor,
        test_backup_precedes_semantic_refusal,
        test_recovery_scan_ignores_inactive_quarantine,
    ):
        print(test.__name__)
        test()
    failures = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failures)} passed, {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
