#!/usr/bin/env python3
"""Registry fail-closed, recovery, and auto-sprout regressions."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / "skills" / "claude" / "cypher-tempre-self-model"
sys.path.insert(0, str(SKILL))

import cambium  # noqa: E402
import encoding_recovery  # noqa: E402
import epochs  # noqa: E402
import modality_ops  # noqa: E402
import registry_store  # noqa: E402
import timechain  # noqa: E402


def _root() -> Path:
    root = Path(tempfile.mkdtemp(prefix="ct-registry-integrity-"))
    (root / "registry").mkdir()
    for name in ("senses.json", "modalities.json"):
        shutil.copy2(SKILL / "registry" / name, root / "registry" / name)
    return root


def _faculty(ident=22, name="Legacy Sensing"):
    return {"id": ident, "name": name, "origin": "test",
            "function": "Detect meaning — without losing bytes.",
            "category": "structural"}


def _grown(*faculties):
    return {"registry": "grown", "modalities": [], "senses": list(faculties)}


def test_absent_is_fresh_but_existing_invalid_utf8_fails_closed():
    root = _root()
    try:
        assert cambium.load_grown(root) == {
            "registry": "grown", "modalities": [], "senses": []}
        target = root / "registry" / "grown.json"
        raw = json.dumps(_grown(_faculty()), ensure_ascii=False).encode("cp1252")
        target.write_bytes(raw)
        try:
            cambium.load_grown(root)
        except timechain.StorageEncodingError as exc:
            assert ("invalid UTF-8" in str(exc) and "encoding_recovery.py" in str(exc)
                    and " inspect " in str(exc))
        else:
            raise AssertionError("existing cp1252 registry was treated as fresh")
        try:
            cambium.load_corpus(root)
        except timechain.StorageEncodingError:
            pass
        else:
            raise AssertionError("load_corpus calculated from a partial registry")
    finally:
        shutil.rmtree(root)


def test_json_io_and_schema_failures_are_integrity_errors():
    root = _root()
    target = root / "registry" / "grown.json"
    try:
        for bad in (
                b'{"registry":"grown",',
                json.dumps([]).encode("utf-8"),
                json.dumps({"registry": "grown", "modalities": {}, "senses": []}).encode(),
                json.dumps(_grown({"id": 3, "name": "Missing Fields"})).encode()):
            target.write_bytes(bad)
            try:
                cambium.load_grown(root)
            except timechain.RegistryIntegrityError:
                pass
            else:
                raise AssertionError(f"invalid registry schema was accepted: {bad!r}")

        target.write_text(json.dumps(_grown()), encoding="utf-8")
        with mock.patch.object(Path, "read_bytes", side_effect=OSError("disk offline")):
            try:
                registry_store.read_registry(target)
            except timechain.RegistryIntegrityError as exc:
                assert "I/O read failed" in str(exc)
            else:
                raise AssertionError("registry I/O failure was not classified as integrity")
    finally:
        shutil.rmtree(root)


def test_epoch_match_does_not_authenticate_invalid_registry():
    root = _root()
    try:
        target = root / "registry" / "grown.json"
        raw = json.dumps(_grown(_faculty()), ensure_ascii=False).encode("cp1252")
        target.write_bytes(raw)
        tc = timechain.Timechain(root)
        tc.genesis(name="legacy anchored corruption")
        # Reproduce a pre-fix epoch that hashed invalid raw bytes as its baseline.
        tc.seal("epoch", {"summary": "legacy raw-byte epoch",
                          "registry_hashes": epochs.registry_hashes(root)}, files=[str(target)])
        assert epochs.registry_hashes(root) == (
            tc._tail_ring()["payload"]["registry_hashes"])
        try:
            cambium.save_grown(root, _grown())
        except timechain.StorageEncodingError:
            pass
        else:
            raise AssertionError("matching epoch authorized invalid UTF-8 overwrite")
        assert target.read_bytes() == raw
        ok, report = epochs.check_epoch(root)
        assert not ok and "integrity failure" in " ".join(report)
    finally:
        shutil.rmtree(root)


def test_grown_ops_never_reset_on_corruption():
    root = _root()
    target = root / "registry" / "grown_ops.json"
    try:
        target.write_bytes(b'{"registry":"grown_ops","ops":')
        original = target.read_bytes()
        for operation in (
                lambda: modality_ops.load_grown_ops(root),
                lambda: modality_ops.register_grown_op(
                    root, "Safe Sensing", {"primitive": "markers", "terms": ["safe"]})):
            try:
                operation()
            except timechain.RegistryIntegrityError:
                pass
            else:
                raise AssertionError("corrupt grown_ops registry was silently reset")
            assert target.read_bytes() == original
    finally:
        shutil.rmtree(root)


def test_blockspace_registry_restore_is_backup_first_and_never_reanchors():
    root = _root()
    try:
        target = root / "registry" / "grown.json"
        intended = _grown(_faculty())
        target.write_text(json.dumps(intended, ensure_ascii=False), encoding="utf-8")
        tc = timechain.Timechain(root)
        tc.genesis(name="snapshot recovery")
        snap_ring = tc.seal("promotion", {"summary": "known-good grown registry"},
                            files=[str(target)])
        head = tc._tail_ring()["ring_hash"]

        damaged = b'{"registry":"grown","senses":['
        target.write_bytes(damaged)
        rows = encoding_recovery.list_registry_snapshots(root, "grown.json")
        assert any(row["ring"] == snap_ring["index"] and row["valid"]
                   and row["senses"] == 1 for row in rows)
        try:
            encoding_recovery.restore_registry_snapshot(
                root, "grown.json", snap_ring["index"])
        except encoding_recovery.RecoveryError:
            pass
        else:
            raise AssertionError("unconfirmed blockspace restore was allowed")
        assert not list(target.parent.glob("grown.json.pre-utf8-*.bak"))

        receipt = encoding_recovery.restore_registry_snapshot(
            root, "grown.json", snap_ring["index"], confirmed=True)
        assert Path(receipt["backup"]).read_bytes() == damaged
        assert cambium.load_grown(root) == intended
        assert receipt["reanchored"] is False and tc._tail_ring()["ring_hash"] == head
        assert epochs.check_epoch(root)[0] is True  # no epoch exists yet; not silently created
        ring = encoding_recovery.reanchor_after_review(
            root, "reviewed blockspace registry recovery", confirmed_reviewed=True)
        assert ring is not None and epochs.check_epoch(root)[0]
    finally:
        shutil.rmtree(root)


def test_restore_preserves_backup_when_snapshot_schema_is_invalid():
    root = _root()
    try:
        target = root / "registry" / "grown.json"
        live = json.dumps(_grown(_faculty()), ensure_ascii=False).encode("utf-8")
        target.write_bytes(live)
        tc = timechain.Timechain(root)
        tc.genesis(name="invalid snapshot")
        invalid = root / "registry" / "invalid-source.json"
        invalid.write_text(json.dumps({"registry": "grown", "senses": [],
                                       "modalities": "not-an-array"}), encoding="utf-8")
        # Attach the invalid candidate under the expected recovery role without
        # changing the live registry path.
        invalid_named = root / "grown.json"
        invalid_named.write_bytes(invalid.read_bytes())
        ring = tc.seal("promotion", {}, files=[str(invalid_named)])
        try:
            encoding_recovery.restore_registry_snapshot(
                root, "grown.json", ring["index"], confirmed=True)
        except encoding_recovery.RecoveryError as exc:
            assert "backup created" in str(exc)
        else:
            raise AssertionError("schema-invalid snapshot was restored")
        backups = list(target.parent.glob("grown.json.pre-utf8-*.bak"))
        assert len(backups) == 1 and backups[0].read_bytes() == live
        assert target.read_bytes() == live
    finally:
        shutil.rmtree(root)


def test_auto_sprout_toggle_and_session_override():
    root = _root()
    old_new, old_legacy = os.environ.pop("CT_AUTO_SPROUT", None), os.environ.pop("CT_AUTOGROW", None)
    try:
        timechain.Timechain(root).genesis(name="auto-sprout test")
        assert cambium.auto_sprout_status(root)["enabled"] is True
        cambium.set_auto_sprout(root, False)
        assert cambium.auto_sprout_status(root)["enabled"] is False
        disabled = cambium.fill_gap(
            root, "cryovolcanic rheology magnetotelluric plume spectroscopy", registry_root=root)
        assert disabled[0]["action"] == "disabled" and not (
            root / "registry" / "grown.json").exists()

        os.environ["CT_AUTO_SPROUT"] = "1"
        status = cambium.auto_sprout_status(root)
        assert status["enabled"] and status["scope"] == "session"
        results = cambium.fill_gap(
            root, "cryovolcanic rheology magnetotelluric plume spectroscopy",
            registry_root=root)
        grown = cambium.load_grown(root)
        assert any(r.get("action") in ("born", "promoted") for r in results)
        assert grown["senses"] and grown["modalities"]
        promotion_rings = [r for r in timechain.Timechain(root).load()
                           if r.get("ring_type") == "promotion"]
        assert promotion_rings and all(
            (r.get("payload", {}).get("op_activation") or {}).get("executed")
            for r in promotion_rings[-2:])
        cambium.set_auto_sprout(root, True)
        os.environ["CT_AUTO_SPROUT"] = "0"
        assert cambium.auto_sprout_status(root)["enabled"] is False
    finally:
        if old_new is None:
            os.environ.pop("CT_AUTO_SPROUT", None)
        else:
            os.environ["CT_AUTO_SPROUT"] = old_new
        if old_legacy is None:
            os.environ.pop("CT_AUTOGROW", None)
        else:
            os.environ["CT_AUTOGROW"] = old_legacy
        shutil.rmtree(root)


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items())
             if name.startswith("test_") and callable(value)]
    for test in tests:
        print(f"[RUN] {test.__name__}")
        test()
    print(f"PASS: {len(tests)} registry integrity regressions")
