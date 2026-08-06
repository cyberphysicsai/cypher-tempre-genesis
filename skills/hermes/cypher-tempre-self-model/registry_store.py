#!/usr/bin/env python3
"""Fail-closed UTF-8 and schema validation for canonical faculty registries.

Only an absent optional registry is treated as fresh.  Once a canonical file
exists, decoding, I/O, JSON, and schema failures propagate to every reader and
mutation preflight so a damaged store can never be mistaken for an empty one.
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path

from timechain import RegistryIntegrityError, StorageEncodingError


CANONICAL_REGISTRIES = (
    "senses.json", "modalities.json", "grown.json", "grown_ops.json",
    "emergent.json",
)

FRESH = {
    "grown.json": {"registry": "grown", "modalities": [], "senses": []},
    "grown_ops.json": {"registry": "grown_ops", "ops": {}},
    "emergent.json": {"registry": "emergent", "faculties": []},
}


def _inspect_command(path: Path) -> str:
    script = Path(__file__).resolve().with_name("encoding_recovery.py")
    return f"python3 {shlex.quote(str(script))} inspect {shlex.quote(str(path))}"


def _integrity_error(path: Path, detail: str) -> RegistryIntegrityError:
    return RegistryIntegrityError(
        f"{path}: {detail}; refusing to continue with an empty or partial "
        f"registry because a later growth event could overwrite promoted "
        f"faculties. Inspect without changing it: {_inspect_command(path)}"
    )


def _require_object(path: Path, value, where: str):
    if not isinstance(value, dict):
        raise _integrity_error(path, f"{where} must be a JSON object")
    return value


def _require_string(path: Path, entry: dict, field: str, where: str):
    value = entry.get(field)
    if not isinstance(value, str) or not value.strip():
        raise _integrity_error(path, f"{where}.{field} must be a non-empty string")


def _validate_faculty(path: Path, entry, where: str, *, emergent: bool = False):
    entry = _require_object(path, entry, where)
    if emergent:
        _require_string(path, entry, "eid", where)
        if entry.get("kind") not in ("sense", "modality"):
            raise _integrity_error(path, f"{where}.kind must be 'sense' or 'modality'")
    else:
        ident = entry.get("id")
        if isinstance(ident, bool) or not isinstance(ident, int) or ident < 0:
            raise _integrity_error(path, f"{where}.id must be a non-negative integer")
    for field in ("name", "function", "category"):
        _require_string(path, entry, field, where)


def validate_registry_object(name: str, data, path=None):
    """Validate one parsed canonical registry and return it unchanged."""
    path = Path(path or name)
    if name not in CANONICAL_REGISTRIES:
        raise _integrity_error(path, f"unknown canonical registry {name!r}")
    data = _require_object(path, data, "root")

    expected = name[:-5]
    if data.get("registry") != expected:
        raise _integrity_error(
            path, f"root.registry must be {expected!r}, got {data.get('registry')!r}")

    if name in ("senses.json", "modalities.json"):
        key = name[:-5]
        entries = data.get(key)
        if not isinstance(entries, list):
            raise _integrity_error(path, f"root.{key} must be an array")
        for index, entry in enumerate(entries):
            _validate_faculty(path, entry, f"root.{key}[{index}]")
    elif name == "grown.json":
        for key in ("modalities", "senses"):
            entries = data.get(key)
            if not isinstance(entries, list):
                raise _integrity_error(path, f"root.{key} must be an array")
            for index, entry in enumerate(entries):
                _validate_faculty(path, entry, f"root.{key}[{index}]")
    elif name == "grown_ops.json":
        ops = data.get("ops")
        if not isinstance(ops, dict):
            raise _integrity_error(path, "root.ops must be an object")
        for op_name, spec in ops.items():
            if not isinstance(op_name, str) or not op_name.strip():
                raise _integrity_error(path, "root.ops keys must be non-empty strings")
            if not isinstance(spec, dict):
                raise _integrity_error(path, f"root.ops[{op_name!r}] must be an object")
            primitive = spec.get("primitive")
            if not isinstance(primitive, str) or not primitive.strip():
                raise _integrity_error(
                    path, f"root.ops[{op_name!r}].primitive must be a non-empty string")
    else:
        entries = data.get("faculties")
        if not isinstance(entries, list):
            raise _integrity_error(path, "root.faculties must be an array")
        for index, entry in enumerate(entries):
            _validate_faculty(path, entry, f"root.faculties[{index}]", emergent=True)
    return data


def read_registry(path: Path):
    """Read one existing registry as strict UTF-8, semantic JSON, and valid schema."""
    path = Path(path)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise _integrity_error(path, f"I/O read failed ({exc})") from exc
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise StorageEncodingError(
            f"{path}: invalid UTF-8 at byte {exc.start}; refusing to treat the "
            f"existing registry as empty. Inspect without changing it: "
            f"{_inspect_command(path)}"
        ) from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise _integrity_error(
            path, f"malformed JSON at line {exc.lineno}, column {exc.colno}") from exc
    return validate_registry_object(path.name, data, path)


def load_registry(root: Path, name: str, *, missing_ok: bool = False):
    path = Path(root) / "registry" / name
    if path.is_symlink():
        raise _integrity_error(path, "canonical registry must not be a symlink")
    if not path.exists():
        if missing_ok and name in FRESH:
            # Return a deep copy: callers mutate these stores in memory.
            return json.loads(json.dumps(FRESH[name]))
        raise _integrity_error(path, "required canonical registry does not exist")
    if not path.is_file():
        raise _integrity_error(path, "canonical registry is not a regular file")
    return read_registry(path)


def validate_registry_set(root: Path) -> dict:
    """Validate every canonical registry that currently exists below *root*."""
    root = Path(root)
    validated = {}
    for name in CANONICAL_REGISTRIES:
        path = root / "registry" / name
        if path.exists() or path.is_symlink():
            validated[name] = load_registry(root, name)
    return validated
