"""Lossless, reviewed faculty gifts beside an unchanged native skill engine.

The format-1 lens projection remains usable by the native importer. Full fidelity
requires this companion: native importers intentionally ignore the extension.
Donor history/calibration is provenance, never recipient experience. Authored
source is retained as inert JSON; this module never imports it or writes Python.
The caller must load its trusted native engine before calling these functions.
"""
from __future__ import annotations

import contextlib
import ast
import copy
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import re
import sys
import uuid
from datetime import datetime, timezone

FORMAT = 1
MAX_BYTES = 4 * 1024 * 1024
DIMENSIONS = ("coherence", "relevance", "novelty", "consistency", "depth", "covenant")
FRUITAGES = ("love", "peace", "joy", "kindness", "mildness", "self-control", "goodness", "patience", "faith")
PRIMITIVES = {"salience", "density", "temporal", "symbols", "repeats", "concepts", "overlap", "richness", "entities", "numbers"}
SIDECAR = "registry/interaction_portability.json"
PENDING = "PORTABILITY_PENDING.json"


class PortabilityError(ValueError):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.details = code, details


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def portable_hash(pack):
    return digest({k: v for k, v in pack.items() if k != "portable_sha256"})


def native_hash(pack):
    return digest({k: pack[k] for k in ("name", "version", "domain", "author", "faculties")})


def _error(code, message):
    raise PortabilityError(code, message)


def _string(value, label, maximum=800, empty=False):
    if not isinstance(value, str) or (not empty and not value.strip()) or len(value) > maximum:
        _error("PACK_INVALID", label + " must be bounded text.")
    return value


def _bounded_json(value, depth=0):
    if depth > 24:
        _error("PACK_INVALID", "Nested data exceeds the portability depth limit.")
    if isinstance(value, dict):
        if len(value) > 2048 or any(not isinstance(k, str) or len(k) > 512 for k in value):
            _error("PACK_INVALID", "Invalid or oversized object.")
        for v in value.values():
            _bounded_json(v, depth + 1)
    elif isinstance(value, list):
        if len(value) > 8192:
            _error("PACK_INVALID", "Oversized array.")
        for v in value:
            _bounded_json(v, depth + 1)
    elif isinstance(value, str):
        if len(value.encode("utf-8")) > 256 * 1024:
            _error("PACK_INVALID", "Oversized text artifact.")
    elif value is not None and not isinstance(value, (bool, int, float)):
        _error("PACK_INVALID", "Only JSON data can travel in a pack.")
    elif isinstance(value, float) and not math.isfinite(value):
        _error("PACK_INVALID", "Non-finite values are not portable.")


def safe_spec(spec):
    """Strict bounded subset of native build_op; no dropped/unknown operands."""
    if not isinstance(spec, dict):
        return False
    primitive = spec.get("primitive")
    if primitive in PRIMITIVES:
        return set(spec) == {"primitive"}
    if primitive == "markers" and set(spec) == {"primitive", "terms"}:
        terms = spec["terms"]
        return (isinstance(terms, list) and 1 <= len(terms) <= 12
                and all(isinstance(x, str) and 0 < len(x) <= 128 for x in terms))
    if primitive == "compose" and set(spec) == {"primitive", "of"}:
        terms = spec["of"]
        return (isinstance(terms, list) and 1 <= len(terms) <= 10
                and all(isinstance(x, str) and x in PRIMITIVES for x in terms)
                and len(terms) == len(set(terms)))
    return False


def _safe_path(root, relative):
    root = Path(root).resolve()
    candidate = root / relative
    if candidate.is_symlink() or any(p.is_symlink() for p in candidate.parents if p != root.parent):
        _error("UNSAFE_PATH", "Portable state may not traverse symbolic links.")
    resolved = candidate.resolve()
    if root not in resolved.parents:
        _error("UNSAFE_PATH", "Portable state escaped the selected agent root.")
    return candidate


def _json(root, relative, default=None):
    path = _safe_path(root, relative)
    if not path.exists():
        return copy.deepcopy(default)
    if path.stat().st_size > 32 * 1024 * 1024:
        _error("STATE_TOO_LARGE", "A local state file exceeds the companion limit.")
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        _bounded_json(result)
        return result
    except (UnicodeError, ValueError) as exc:
        raise PortabilityError("STATE_INVALID", "Unreadable portable state: " + relative) from exc


def _atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(".p-" + uuid.uuid4().hex[:8] + ".tmp")
    try:
        with temp.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _write_json(path, value):
    _atomic(path, canonical(value) + b"\n")


def _head(tc):
    ring = tc._tail_ring()
    if not ring:
        _error("NO_GENESIS", "A verified native genesis is required.")
    return {"index": ring["index"], "hash": ring["ring_hash"]}


def _verified(root, writable=False, recovery=False):
    from timechain import Timechain
    import epochs
    root = Path(root).resolve()
    _safe_path(root, "chain/rings.jsonl")
    tc = Timechain(root)
    if (tc.dir / PENDING).exists() and not recovery:
        _error("PORTABILITY_INCOMPLETE", "A portable import needs recovery review before this agent can be used.")
    ok, report = tc.verify()
    if not ok:
        _error("CHAIN_INVALID", "Native verification failed: " + "; ".join(report))
    ok, report = epochs.check_epoch(root)
    if not ok:
        _error("REGISTRY_INVALID", "Native registry epoch failed: " + "; ".join(report))
    _head(tc)
    if writable and ((tc.dir / "LOCKED").exists() or (tc.dir / "PAUSED").exists()):
        _error("AGENT_NOT_WRITABLE", "Resume or recover the agent before a portable import.")
    # The sidecar is outside native registry epochs; authenticate its live bytes
    # against the latest companion adoption, never against donor assertions.
    latest = None
    for ring in tc.iter_rings():
        adoption = (ring.get("payload") or {}).get("portable_adoption")
        if isinstance(adoption, dict) and SIDECAR in adoption.get("stateHashes", {}):
            latest = adoption["stateHashes"][SIDECAR]
    side = _safe_path(root, SIDECAR)
    if (latest is not None and not side.exists()) or (side.exists() and (latest is None or hashlib.sha256(side.read_bytes()).hexdigest() != latest)):
        _error("PORTABILITY_TAMPERED", "The live portability sidecar differs from its sealed adoption.")
    return tc


def _registries(root):
    from registry_store import load_registry
    return {name: load_registry(Path(root), name, missing_ok=name not in ("modalities.json", "senses.json"))
            for name in ("modalities.json", "senses.json", "grown.json", "grown_ops.json", "emergent.json")}


def _learned(root, kind, entry):
    labeler = _json(root, "registry/labeler.json", {}) or {}
    source_key = kind + ":" + str(entry.get("id"))
    head = (labeler.get("labels") or {}).get(source_key)
    return {"activation": "retained-inactive", "sourceKey": source_key,
            "extractorHead": copy.deepcopy(head),
            "extractorMetadata": {k: copy.deepcopy(v) for k, v in labeler.items() if k != "labels"},
            "note": "Donor calibration is retained for review, not counted as recipient training or evidence."}


def _requires_module(entries, source):
    declared_names = set()
    try:
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "OPS" for t in node.targets) and isinstance(node.value, ast.Dict):
                declared_names.update(k.value for k in node.value.keys if isinstance(k, ast.Constant) and isinstance(k.value, str))
    except SyntaxError:
        pass  # Invalid authored source can still travel inert when selected.
    return any(e["artifacts"] or e["name"] in declared_names or (
        _mechanism(e)["compatibility"] == "unsupported"
        and (e["definition"].get("effect") or {}).get("type") != "frame"
        and not safe_spec(e.get("grownOp"))) for e in entries)


def export_pack(root, keys, name="Cypher Tempre portable faculties", version="1.0.0", domain=""):
    root = Path(root).resolve()
    tc = _verified(root)
    regs = _registries(root)
    if not isinstance(keys, list) or not 1 <= len(keys) <= 50 or any(not isinstance(k, str) for k in keys) or len(set(keys)) != len(keys):
        _error("PACK_INVALID", "Select one through fifty distinct faculty keys.")
    lookup = {}
    for plural, kind in (("modalities", "modality"), ("senses", "sense")):
        for f in regs["grown.json"][plural]:
            lookup[kind + ":" + str(f["id"])] = (kind, f, "grown")
    for e in regs["emergent.json"]["faculties"]:
        lookup["emergent:" + e["eid"]] = (e["kind"], e, "emergent")
    prior = _json(root, SIDECAR, {"entries": {}})
    entries, lenses = [], []
    for key in keys:
        if not isinstance(key, str) or key not in lookup:
            _error("PACK_INVALID", "Only present grown or emergent faculties may be exported: " + str(key))
        kind, f, store = lookup[key]
        lifecycle = [copy.deepcopy(e) for e in regs["emergent.json"]["faculties"]
                     if e.get("kind") == kind and (e.get("promoted_to_id") == f.get("id") and store == "grown"
                                                  or e.get("eid") == f.get("eid") and store == "emergent")]
        effect = f.get("effect") or {}
        op_name = effect.get("name", f["name"]) if isinstance(effect, dict) else f["name"]
        grown_op = copy.deepcopy(regs["grown_ops.json"]["ops"].get(op_name))
        artifacts = []
        for e in lifecycle + ([f] if store == "emergent" else []):
            code = e.get("op_code")
            if isinstance(code, str) and code and not any(a["text"] == code for a in artifacts):
                artifacts.append({"kind": "authored-source", "text": code,
                                  "sha256": hashlib.sha256(code.encode("utf-8")).hexdigest(), "activation": "quarantined"})
        learned = _learned(root, kind, f)
        if learned["extractorHead"] is None:
            prior_states = [item.get("entry", {}).get("learnedState") for item in prior.get("entries", {}).get(key, [])]
            prior_states = [state for state in prior_states if isinstance(state, dict) and state.get("extractorHead") is not None]
            if prior_states:
                learned = copy.deepcopy(prior_states[-1])
                learned["activation"] = "retained-inactive"
                learned["localKey"] = key
        entry = {"key": key, "kind": kind, "name": f["name"], "store": store,
                 "definition": copy.deepcopy(f), "emergentRecords": lifecycle,
                 "grownOp": grown_op, "grownOpName": op_name,
                 "learnedState": learned, "artifacts": artifacts,
                 "lineage": copy.deepcopy(prior.get("entries", {}).get(key, []))}
        entries.append(entry)
        lenses.append({"kind": kind, "name": f["name"], "function": f["function"],
                       "category": f["category"], "seed_terms": copy.deepcopy(f.get("seed_terms", [])),
                       "status": "emergent" if store == "emergent" else "promoted",
                       "provenance": {"origin": f.get("origin", ""), "donor_id": f.get("id"), "eid": f.get("eid")}})
    genesis = next(tc.iter_rings())
    head = _head(tc)
    selected_imports = {item.get("packHash") for key in keys for item in prior.get("entries", {}).get(key, [])}
    shared = []
    for imported in prior.get("imports", []):
        if imported.get("packHash") in selected_imports:
            for artifact in imported.get("artifacts", []):
                if _requires_module(entries, artifact["text"]) and artifact.get("sha256") not in {a["sha256"] for a in shared}:
                    shared.append(copy.deepcopy(artifact))
    authored_path = _safe_path(root, "active_ops.py")
    if authored_path.exists():
        source = authored_path.read_bytes()
        text = source.decode("utf-8")
        requires_source = _requires_module(entries, source)
        source_digest = hashlib.sha256(source).hexdigest()
        if requires_source and source_digest not in {a["sha256"] for a in shared}:
            shared.append({"kind": "authored-module", "text": text,
                           "sha256": source_digest, "activation": "quarantined",
                           "note": "Whole donor module retained inert for a selected authored/unresolved capability. It may include additional helper functions or personal data; review the module before sharing."})
    pack = {"pack_format": 1, "name": _string(name, "name", 128), "version": _string(version, "version", 48),
            "domain": _string(domain, "domain", 256, empty=True), "author": genesis["payload"].get("name", "unknown"),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "donor": {"genesis_name": genesis["payload"].get("name"), "genesis_hash": genesis["ring_hash"],
                      "chain_head_index": head["index"], "chain_head_hash": head["hash"]},
            "faculties": lenses,
            "interaction_portability": {"format": FORMAT, "entries": entries, "artifacts": shared,
                 "requiresCompanion": True, "donorIdentityVerified": False,
                 "learnedStatePolicy": "preserve-inactive; no global calibration or donor experience adoption"}}
    pack["pack_sha256"] = native_hash(pack)
    pack["portable_sha256"] = portable_hash(pack)
    return validate_pack(pack)


def validate_pack(pack):
    if not isinstance(pack, dict):
        _error("PACK_INVALID", "A faculty pack must be an object.")
    _bounded_json(pack)
    if len(canonical(pack)) > MAX_BYTES:
        _error("PACK_INVALID", "A portable pack exceeds four MiB.")
    if pack.get("pack_format") != 1 or isinstance(pack.get("pack_format"), bool):
        _error("PACK_INVALID", "The native projection must use format 1.")
    for field, maximum in (("name", 128), ("version", 48), ("domain", 256), ("author", 256)):
        _string(pack.get(field), field, maximum, empty=field == "domain")
    lenses = pack.get("faculties")
    if not isinstance(lenses, list) or not 1 <= len(lenses) <= 50:
        _error("PACK_INVALID", "A pack requires one through fifty faculties.")
    if pack.get("pack_sha256") != native_hash(pack):
        _error("PACK_HASH", "Native projection hash mismatch.")
    ext = pack.get("interaction_portability")
    if not isinstance(ext, dict) or ext.get("format") != FORMAT or isinstance(ext.get("format"), bool):
        _error("COMPANION_REQUIRED", "A full fidelity pack requires the portability extension; a native lens-only pack cannot recover omitted data.")
    if pack.get("portable_sha256") != portable_hash(pack):
        _error("PACK_HASH", "Complete portable pack hash mismatch.")
    entries = ext.get("entries")
    if not isinstance(entries, list) or len(entries) != len(lenses):
        _error("PACK_INVALID", "Every native lens must have one complete portability entry.")
    identities = set()
    for lens, entry in zip(lenses, entries):
        if not isinstance(lens, dict) or not isinstance(entry, dict):
            _error("PACK_INVALID", "Faculty entries must be objects.")
        kind, name = entry.get("kind"), entry.get("name")
        _string(entry.get("key"), "source faculty key", 160)
        if kind not in ("sense", "modality") or (kind, str(name).casefold()) in identities:
            _error("PACK_INVALID", "Faculty identities must be valid and unique.")
        identities.add((kind, str(name).casefold()))
        _string(name, "faculty name", 160)
        definition = entry.get("definition")
        if not isinstance(definition, dict) or entry.get("store") not in ("grown", "emergent"):
            _error("PACK_INVALID", "Missing source definition/store.")
        for key, bound in (("name", 160), ("function", 800), ("category", 128)):
            _string(definition.get(key), key, bound)
            if definition.get(key) != lens.get(key):
                _error("PACK_INVALID", "Native projection differs from full faculty definition.")
        if name != definition["name"] or kind != lens.get("kind") or definition.get("seed_terms", []) != lens.get("seed_terms", []):
            _error("PACK_INVALID", "Native faculty identity/seed projection differs.")
        seeds = definition.get("seed_terms", [])
        if not isinstance(seeds, list) or len(seeds) > 128 or any(not isinstance(s, str) or len(s) > 128 for s in seeds):
            _error("PACK_INVALID", "Seed terms must be bounded labels.")
        lifecycle = entry.get("emergentRecords")
        if not isinstance(lifecycle, list) or len(lifecycle) > 128:
            _error("PACK_INVALID", "Invalid lifecycle records.")
        for e in lifecycle:
            if not isinstance(e, dict) or e.get("kind") != kind or e.get("name") != name:
                _error("PACK_INVALID", "Lifecycle records must identify their own faculty.")
        for artifact in entry.get("artifacts", []):
            _artifact(artifact)
    for artifact in ext.get("artifacts", []):
        _artifact(artifact)
    return copy.deepcopy(pack)


def _artifact(value):
    if not isinstance(value, dict) or value.get("kind") not in ("authored-source", "authored-module"):
        _error("PACK_INVALID", "Unsupported inert artifact type.")
    text = _string(value.get("text"), "authored source", 256 * 1024)
    if value.get("sha256") != hashlib.sha256(text.encode("utf-8")).hexdigest():
        _error("PACK_HASH", "Authored artifact digest mismatch.")


def _mechanism(entry):
    effect = entry["definition"].get("effect")
    op = entry.get("grownOp")
    code = bool(entry.get("artifacts")) or any(e.get("op_code") for e in entry["emergentRecords"])
    fields = ["definition", "seed_terms", "lifecycle", "provenance", "lineage", "learnedState(retained-inactive)"]
    if effect is not None:
        fields.append("effect")
    if op is not None:
        fields.append("grown_ops")
    if code:
        return {"mechanism": "authored-source", "compatibility": "quarantined", "preservedFields": fields + ["authoredSource(inert)"],
                "reason": "Authored source requires separate recipient approval and activation; donor approval never transfers."}
    if op is not None and not safe_spec(op):
        return {"mechanism": "unknown-operator", "compatibility": "unsupported", "preservedFields": fields,
                "reason": "The operator is retained inert because it is outside the audited native primitive grammar."}
    if isinstance(effect, dict):
        typ = effect.get("type")
        if typ == "op":
            spec = effect.get("spec", op)
            if not safe_spec(spec) or op is None or spec != op:
                return {"mechanism": "unresolved-operator", "compatibility": "unsupported", "preservedFields": fields,
                        "reason": "The effect's operator dependency is missing, inconsistent, or unsupported."}
        elif typ == "frame":
            if set(effect) - {"type", "text"} or not isinstance(effect.get("text"), str) or len(effect["text"]) > 16000:
                _error("PACK_INVALID", "Invalid reasoning frame.")
        elif typ == "hint":
            if set(effect) - {"type", "bias"} or effect.get("bias") not in ("replay", "partial", "model"):
                _error("PACK_INVALID", "Invalid routing hint.")
        else:
            return {"mechanism": "unknown-effect", "compatibility": "unsupported", "preservedFields": fields,
                    "reason": "Unknown effect retained inert."}
    return {"mechanism": "safe-primitive" if op is not None else (effect or {}).get("type", "descriptive-lens"),
            "compatibility": "supported" if op is not None or effect else "frame-only", "preservedFields": fields}


def _stage(root, pack):
    regs = _registries(root)
    grown, emergent, operations = regs["grown.json"], regs["emergent.json"], regs["grown_ops.json"]
    side = _json(root, SIDECAR, {"format": 1, "entries": {}, "imports": []})
    report = {"imported": [], "skipped": [], "portability": {"formatVersion": FORMAT, "items": [],
              "requiresCompanion": True, "quarantinedCodeCount": 0}}
    names = {}
    for plural, kind in (("modalities", "modality"), ("senses", "sense")):
        for f in regs[plural + ".json"][plural] + grown[plural]:
            names.setdefault(f["name"].casefold(), []).append((kind, f))
    for e in emergent["faculties"]:
        if not e.get("promoted_to_id"):
            names.setdefault(e["name"].casefold(), []).append((e["kind"], e))
    next_ids = {kind: max([f["id"] for f in regs[plural + ".json"][plural] + grown[plural]] or [-1]) + 1
                for plural, kind in (("modalities", "modality"), ("senses", "sense"))}
    existing_eids = {e["eid"] for e in emergent["faculties"]}
    def eid():
        n = 1
        while "E" + str(n) in existing_eids:
            n += 1
        value = "E" + str(n); existing_eids.add(value)
        return value
    for entry in pack["interaction_portability"]["entries"]:
        kind, name = entry["kind"], entry["name"]
        status = _mechanism(entry)
        quarantined = status["compatibility"] in ("quarantined", "unsupported")
        report["portability"]["items"].append({"key": entry["key"], "name": name, **status,
             "sourceStatus": entry["definition"].get("status", "active"),
             "learnedStateActivation": "retained-inactive"})
        report["portability"]["quarantinedCodeCount"] += len(entry.get("artifacts", []))
        collision = names.get(name.casefold(), [])
        if collision:
            matched = [key for key, lineage in side.get("entries", {}).items()
                       if any(item.get("packHash") == pack["portable_sha256"] and item.get("sourceKey") == entry["key"] for item in lineage)]
            if matched:
                report["skipped"].append({"name": name, "reason": "same complete pack already imported", "key": matched[0]})
                continue
            _error("PACK_COLLISION", "A local faculty already uses this name; imports never overwrite its definition or learned state: " + name)
        definition = copy.deepcopy(entry["definition"])
        target_eid = None
        if entry["store"] == "emergent":
            target_eid = eid()
            definition.update(eid=target_eid, promoted_to_id=None, status="emergent", activated=False)
            definition.pop("activated_at", None)
            target = "emergent:" + target_eid
            emergent["faculties"].append(definition)
        else:
            new_id = next_ids[kind]; next_ids[kind] += 1
            definition["id"] = new_id
            target = kind + ":" + str(new_id)
            if quarantined:
                definition["status"] = "dormant"
                definition.pop("effect", None)
            grown["modalities" if kind == "modality" else "senses"].append(definition)
            if not quarantined and entry.get("grownOp") is not None:
                op_name = entry.get("grownOpName", name)
                if op_name in operations["ops"] and operations["ops"][op_name] != entry["grownOp"]:
                    _error("PACK_COLLISION", "A local operator dependency already uses this name: " + op_name)
                operations["ops"][op_name] = copy.deepcopy(entry["grownOp"])
            for source_record in entry["emergentRecords"]:
                e = copy.deepcopy(source_record)
                e.update(eid=eid(), promoted_to_id=None if quarantined else new_id)
                if quarantined:
                    e.update(activated=False, status="emergent")
                    e.pop("activated_at", None)
                e["portable_source_eid"] = source_record.get("eid")
                emergent["faculties"].append(e)
        definition["origin"] = "imported:" + pack["name"] + "@" + pack["version"]
        definition["provenance"] = {**(definition.get("provenance") if isinstance(definition.get("provenance"), dict) else {}),
             "portableImport": {"packHash": pack["portable_sha256"], "sourceKey": entry["key"], "donor": pack.get("donor"), "donorIdentityVerified": False}}
        if quarantined:
            definition["portable_quarantine"] = status["reason"]
        names[name.casefold()] = [(kind, definition)]
        side["entries"].setdefault(target, []).append({"packHash": pack["portable_sha256"], "sourceKey": entry["key"],
              "donor": pack.get("donor"), "entry": copy.deepcopy(entry), "learnedStateActivation": "retained-inactive"})
        report["imported"].append({"key": target, "kind": kind, "name": name, "id": definition.get("id"), "eid": target_eid,
                                    "compatibility": status["compatibility"]})
    items = report["portability"]["items"]
    report["portability"]["counts"] = {k: sum(x["compatibility"] == k for x in items) for k in ("supported", "frame-only", "quarantined", "unsupported")}
    report["portability"]["quarantinedCodeCount"] += len(pack["interaction_portability"].get("artifacts", []))
    if report["imported"]:
        side["imports"].append({"packHash": pack["portable_sha256"], "donor": pack.get("donor"),
             "artifacts": copy.deepcopy(pack["interaction_portability"].get("artifacts", []))})
    from registry_store import validate_registry_object
    proposed = {"registry/grown.json": grown, "registry/emergent.json": emergent,
                "registry/grown_ops.json": operations, SIDECAR: side}
    for path, obj in proposed.items():
        if path != SIDECAR:
            validate_registry_object(Path(path).name, obj)
    return report, proposed


def preview_import(root, pack):
    root = Path(root).resolve()
    tc = _verified(root)
    pack = validate_pack(pack)
    report, proposed = _stage(root, pack)
    plan = {"action": "import-portable-faculties", "rootBinding": hashlib.sha256(os.path.normcase(str(root)).encode("utf-8")).hexdigest(), "expectedHead": _head(tc)["hash"],
            "packHash": pack["portable_sha256"], "donorIdentityVerified": False,
            "userIntent": "The user selected this complete faculty pack for import into this local agent.",
            "scope": "Add reviewed local capabilities and their provenance. Preserve all existing rings and the genesis covenant. No donor history is adopted.",
            "changes": report["imported"], "portability": report["portability"],
            "faculties": [{"kind": e["kind"], "name": e["name"],
                "definition": e["definition"], "operator": e.get("grownOp"),
                "authoredArtifacts": [{"sha256": a["sha256"], "activation": "quarantined"} for a in e.get("artifacts", [])]}
                for e in pack["interaction_portability"]["entries"]],
            "stateAfter": {p: hashlib.sha256(canonical(v) + b"\n").hexdigest() for p, v in proposed.items()},
            "retainedInactive": "Authored source, unknown mechanisms and donor learned-state snapshots remain inert. No source code is loaded and no global calibration is replaced.",
            "reversibility": "Faculties can be hibernated without deleting definitions/history. Source activation requires separate recipient approval.",
            "safeguards": ["fresh semantic and native gate", "expected-head lock", "write-ahead journal and native lockdown on incomplete import", "native registry epoch and immutable adoption receipt"]}
    return {"plan": plan, "planHash": digest(plan), "expectedHead": plan["expectedHead"], "report": report,
            "head": _head(tc), "donorVerified": False}


def validate_review(root, plan, review):
    if not isinstance(review, dict) or review.get("planHash") != digest(plan) or review.get("expectedHead") != plan["expectedHead"]:
        _error("REVIEW_INVALID", "The fresh review must bind this exact plan and expected head.")
    try:
        at = datetime.fromisoformat(review["reviewedAt"].replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - at).total_seconds()
    except (KeyError, TypeError, ValueError):
        _error("REVIEW_INVALID", "A timezone-aware review timestamp is required.")
    if not -30 <= age <= 600:
        _error("REVIEW_EXPIRED", "Review again immediately before applying this plan.")
    scores, assessment = review.get("scores"), review.get("assessment")
    if not isinstance(scores, dict) or any(isinstance(scores.get(k), bool) or not isinstance(scores.get(k), int) or not 0 <= scores[k] <= 255 for k in DIMENSIONS):
        _error("REVIEW_INVALID", "Six explicit integer scores from 0 through 255 are required.")
    if not isinstance(assessment, dict) or assessment.get("approved") is not True:
        _error("COVENANT_REJECTED", "The semantic reviewer did not approve this import.")
    fruits = assessment.get("fruitages")
    if not isinstance(fruits, dict) or any(isinstance(fruits.get(k), bool) or not isinstance(fruits.get(k), int) or not 0 <= fruits[k] <= 255 for k in FRUITAGES):
        _error("REVIEW_INVALID", "The semantic reviewer must score all nine fruitages.")
    _string(assessment.get("rationale"), "review rationale", 16000)
    import immune
    gate_class = next((v for k, v in vars(immune).items() if k.endswith("Gate") and isinstance(v, type)), None)
    if gate_class is None:
        _error("ENGINE_UNSUPPORTED", "The trusted engine exposes no native gate.")
    gate_module = sys.modules[gate_class.__module__]
    thresholds = gate_module.policy_thresholds(Path(root))
    floor = max(180, thresholds["covenant_floor"])
    clean = {k: scores[k] for k in DIMENSIONS}
    clean["covenant"] = min(clean["covenant"], *[fruits[k] for k in FRUITAGES])
    if clean["covenant"] < floor:
        _error("COVENANT_REJECTED", "A fruitage or covenant score is below the native/bridge floor.")
    action = canonical(plan).decode("utf-8")
    screen = immune.Immune(Path(root)).screen(action)
    if screen.get("blocked"):
        _error("INPUT_BLOCKED", "The native immune membrane rejected the operation plan.")
    verdict = gate_class(thresholds).evaluate(action, [], context=action, external_scores=clean)
    if verdict.get("decision") != "SEAL":
        raise PortabilityError("POI_REJECTED", "The native gate withheld the portable import.", verdict=verdict)
    return {"scores": clean, "assessment": copy.deepcopy(assessment), "verdict": verdict,
            "reviewedAt": review["reviewedAt"], "planHash": digest(plan)}


@contextlib.contextmanager
def _lock(tc):
    with (tc.dir / ".seal.lock").open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0, 2)
            if handle.tell() == 0:
                handle.write(b"\0"); handle.flush()
            handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def import_pack(root, pack, expected_head, review, plan_hash, confirmed=True, review_validator=None):
    """Apply only a fresh, exact reviewed plan; any incomplete write stays locked."""
    if confirmed is not True:
        _error("CONFIRMATION_REQUIRED", "Explicit confirmation of the import plan is required.")
    root = Path(root).resolve()
    tc = _verified(root, writable=True)
    pack = validate_pack(pack)
    with _lock(tc):
        tc = _verified(root, writable=True)
        preview = preview_import(root, pack)
        if expected_head != preview["expectedHead"]:
            _error("STALE_HEAD", "The chain advanced; review a fresh import plan.")
        if plan_hash != preview["planHash"]:
            _error("STALE_PLAN", "The import plan changed; review it again.")
        reviewed = validate_review(root, preview["plan"], review)
        if review_validator is not None:
            review_validator(root, preview["plan"], review)
        report, proposed = _stage(root, pack)
        if not report["imported"]:
            return {"accepted": True, "imported": [], "ring": None, "head": _head(tc), "report": report}
        import epochs
        from timechain import Timechain
        previous_seal = Timechain.seal
        own_lock = canonical({"source": "interaction-portability", "transaction": uuid.uuid4().hex}) + b"\n"
        lock_path = tc.dir / "LOCKED"
        journal_id = json.loads(own_lock)["transaction"]
        transaction = _safe_path(root, "chain/portable-imports/" + journal_id)
        transaction.mkdir(parents=True)
        journal_path = transaction / "journal.json"
        marker = tc.dir / PENDING
        original_head = _head(tc)
        journal = {"format": 1, "stage": "prepared", "transaction": journal_id,
                   "beforeHead": original_head, "packHash": pack["portable_sha256"], "planHash": plan_hash,
                   "files": {}, "lockSha256": hashlib.sha256(own_lock).hexdigest()}
        score_parameter = list(inspect.signature(Timechain._seal_locked).parameters)[4]
        def native_seal(instance, ring_type, payload, files=None, score_vector=None, **kwargs):
            if instance.root.resolve() != root:
                _error("UNSAFE_PATH", "A native writer attempted another root.")
            owned = lock_path.exists() and lock_path.read_bytes() == own_lock
            if owned:
                lock_path.unlink()
            try:
                if score_vector is not None:
                    kwargs[score_parameter] = score_vector
                return instance._seal_locked(ring_type, payload, files=files, **kwargs)
            finally:
                if owned and not lock_path.exists():
                    _atomic(lock_path, own_lock)
        try:
            Timechain.seal = native_seal
            ticket = epochs.begin_mutation(root)
            journal["beforeHead"] = _head(tc)
            for relative, value in proposed.items():
                path = _safe_path(root, relative)
                before = path.read_bytes() if path.exists() else None
                backup = hashlib.sha256(relative.encode()).hexdigest()[:16]
                if before is not None:
                    _atomic(transaction / backup, before)
                journal["files"][relative] = {"before": hashlib.sha256(before).hexdigest() if before is not None else None,
                    "backup": backup if before is not None else None,
                    "after": hashlib.sha256(canonical(value) + b"\n").hexdigest()}
            _write_json(journal_path, journal)
            _write_json(marker, {"transaction": journal_id, "journal": journal_path.relative_to(root).as_posix(), "planHash": plan_hash})
            # Do not overwrite an immune lockdown created between preflight
            # and this guard; the exclusive create preserves that evidence.
            with lock_path.open("xb") as guard:
                guard.write(own_lock); guard.flush(); os.fsync(guard.fileno())
            for relative, value in proposed.items():
                _write_json(_safe_path(root, relative), value)
            epochs.commit_mutation(root, ticket, reason="reviewed portable faculty import " + pack["portable_sha256"])
            hashes = {p: meta["after"] for p, meta in journal["files"].items()}
            ring = native_seal(tc, "faculty-transfer", {
                "summary": "Reviewed portable faculty import; capabilities and provenance retained, donor history not adopted.",
                "portable_adoption": {"transaction": journal_id, "packHash": pack["portable_sha256"],
                    "planHash": plan_hash, "stateHashes": hashes, "imported": report["imported"],
                    "portability": report["portability"]},
                "semantic_review": reviewed, "donor_identity_verified": False,
            }, files=[_safe_path(root, p) for p in proposed], score_vector=reviewed["scores"])
            journal.update(stage="committed", ring={"index": ring["index"], "hash": ring["ring_hash"]})
            _write_json(journal_path, journal)
            if lock_path.read_bytes() != own_lock:
                _error("PORTABILITY_INCOMPLETE", "Another native lockdown replaced the transaction guard.")
            marker.unlink()
            lock_path.unlink()
        except Exception as exc:
            if marker.exists():
                journal.update(stage="needs-review", error=type(exc).__name__)
                try:
                    _write_json(journal_path, journal)
                    if not lock_path.exists():
                        _atomic(lock_path, own_lock)
                except OSError:
                    pass
                raise PortabilityError("PORTABILITY_INCOMPLETE", "Import stopped. Durable backups and native lockdown preserve recovery evidence; no history was rewritten.", transaction=journal_id) from exc
            raise
        finally:
            Timechain.seal = previous_seal
    _verified(root)
    return {"accepted": True, "imported": report["imported"], "ring": journal["ring"],
            "head": _head(tc), "report": report, "donorVerified": False}


def recovery_status(root):
    """Read-only crash diagnosis. Never bless changed bytes or rewrite history."""
    root = Path(root).resolve()
    marker = _json(root, "chain/" + PENDING)
    if marker is None:
        return {"pending": False}
    relative = marker.get("journal")
    if isinstance(relative, str):
        relative = relative.replace("\\", "/")
    if not isinstance(relative, str) or not re.fullmatch(r"chain/portable-imports/[0-9a-f]{32}/journal\.json", relative):
        _error("STATE_INVALID", "Invalid portability recovery journal path.")
    journal = _json(root, relative)
    return {"pending": True, "locked": (root / "chain/LOCKED").exists(),
            "journal": journal, "automaticRollback": False,
            "notice": "Preserve the chain and backups. Recovery requires checking whether new registry epochs/adoption rings exist; never restore over committed history."}


def verified_portability_state(root):
    """Authenticated inert-artifact accessor for explicit local code review."""
    _verified(root)
    return _json(root, SIDECAR, {"format": FORMAT, "entries": {}, "imports": []})
