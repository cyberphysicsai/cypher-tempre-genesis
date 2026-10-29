"""Explicit local approval and bounded execution of skill-authored operators.

This is process isolation, not a security sandbox. Approval authorizes the
operator and its imports with the user's OS permissions. No HTTP endpoint grants
approval. Incoming faculty packs must never install approval records.
"""
from __future__ import annotations

import ast
import base64
import contextlib
import hashlib
import io
import json
import os
import stat
from pathlib import Path
import subprocess
import sys
import threading
import types

ENGINE = Path(__file__).resolve().parent / "engine" / "proof-of-interaction"
TRUST_ROOT = Path(__file__).resolve().parent / ".local" / "operator-approvals"
MAX_SOURCE = 1024 * 1024
MAX_OUTPUT = 512 * 1024
MAX_INPUT = 8 * 1024 * 1024
EXCLUDED = {"chain", "registry", "blockspace", ".git", ".venv", "venv", "node_modules", "__pycache__"}


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _root(root):
    return Path(root).expanduser().resolve()


def _identity(root):
    return os.path.normcase(str(_root(root)))


def _is_link(path):
    if path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)()):
        return True
    if os.name == "nt":
        try:
            return bool(path.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
        except FileNotFoundError:
            pass
    return False


def _trust_record_path(root, create=False):
    """Local approval authority lives outside every imported agent directory."""
    root = _root(root)
    directory = Path(TRUST_ROOT).absolute()
    if any(_is_link(part) for part in (directory, *directory.parents)):
        raise ValueError("The installation-local approval directory may not traverse links.")
    resolved = directory.resolve()
    if resolved == root or resolved.is_relative_to(root):
        raise ValueError("The local approval directory must be outside the selected agent.")
    if create:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.exists() and not directory.is_dir():
        raise ValueError("The local approval directory is not a directory.")
    target = directory / (_hash(_identity(root).encode("utf-8")) + ".json")
    if _is_link(target):
        raise ValueError("Local approval records may not be symbolic links.")
    return target


def _approval_binding(manifest):
    return {"format": 1, "root": manifest["root"], "genesisHash": manifest["genesisHash"],
            "ring": manifest["ring"], "ringHash": manifest["ringHash"],
            "manifestSha256": _hash(_canonical(manifest))}


def _locally_approved(root, manifest):
    record = _trust_record_path(root)
    if not record.is_file() or record.stat().st_size > 65536:
        return False
    value = json.loads(record.read_text(encoding="utf-8"))
    return value == _approval_binding(manifest)


def _save_local_approval(root, manifest):
    record = _trust_record_path(root, create=True)
    temporary = record.with_name(".approval-" + os.urandom(16).hex() + ".tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(_canonical(_approval_binding(manifest)) + b"\n")
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, record)
    finally:
        temporary.unlink(missing_ok=True)


def _environment(root):
    """Bind local Python dependencies too; caches and agent data are excluded."""
    entries, total = {}, 0
    for directory, folders, files in os.walk(root, followlinks=False):
        folders[:] = sorted(f for f in folders if f not in EXCLUDED and not (Path(directory) / f).is_symlink())
        for name in sorted(files):
            if not name.endswith(".py"):
                continue
            file = Path(directory) / name
            if file.is_symlink() or not file.resolve().is_relative_to(root):
                raise ValueError("Local Python dependencies must stay inside the approved root.")
            data = file.read_bytes()
            total += len(data)
            if len(entries) >= 2048 or total > 32 * 1024 * 1024:
                raise ValueError("The local operator dependency manifest exceeds its limit.")
            entries[file.relative_to(root).as_posix()] = _hash(data)
    return _hash(_canonical(entries))


def _runtime(path):
    path = Path(path).resolve()
    files = sorted(path.glob("*.py"))
    if not (path / "timechain.py").is_file() or len(files) > 2048:
        raise ValueError("The approved native runtime is unavailable.")
    entries, total = {}, 0
    for file in files:
        if file.is_symlink():
            raise ValueError("Runtime source must be regular local files.")
        data = file.read_bytes()
        total += len(data)
        if total > 32 * 1024 * 1024:
            raise ValueError("Runtime source exceeds the approval limit.")
        entries[file.name] = _hash(data)
    return {"engineDirectory": str(path), "runtimeSha256": _hash(_canonical(entries))}


def _source(root):
    root = _root(root)
    file = root / "active_ops.py"
    if not file.exists():
        return None
    if file.is_symlink() or not file.resolve().is_relative_to(root) or file.stat().st_size > MAX_SOURCE:
        raise ValueError("The local active_ops.py must be a regular bounded file inside the selected agent.")
    data = file.read_bytes()
    tree = ast.parse(data, filename=str(file))  # Parse only; inspection never imports code.
    names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "OPS" for t in node.targets) and isinstance(node.value, ast.Dict):
            names.extend(k.value for k in node.value.keys if isinstance(k, ast.Constant) and isinstance(k.value, str))
    return {"path": file, "bytes": data, "sha256": _hash(data), "environmentSha256": _environment(root),
            "declaredNames": sorted(set(names))}


def _native():
    if sys.argv[1:] != ["--worker"]:
        inert = types.ModuleType("active_ops")
        inert.OPS = {}
        sys.modules["active_ops"] = inert
    # The companion may have explicitly loaded another trusted native skill.
    # Preserve that selection; do not change its registry/receipt implementation.
    if "timechain" not in sys.modules and str(ENGINE) not in sys.path:
        sys.path.insert(0, str(ENGINE))
    from timechain import Timechain
    import epochs
    return Timechain, epochs


def inspect_source(root):
    root = _root(root)
    result = {"available": False, "approved": False, "source": "active_ops.py",
              "activation": "local-cli-only", "isSandbox": False,
              "notice": "Locally approved Python runs with your OS permissions, including its imports. Review it before approval."}
    try:
        source = _source(root)
        if source is None:
            return result
        result.update(available=True, sha256=source["sha256"], environmentSha256=source["environmentSha256"],
                      declaredNames=source["declaredNames"], reason="Local source requires explicit approval.")
        manifest_file = root / "chain" / "operator-approval.json"
        if not manifest_file.exists():
            return result
        if manifest_file.is_symlink() or manifest_file.stat().st_size > 65536:
            raise ValueError("Invalid approval manifest.")
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        if not _locally_approved(root, manifest):
            result["reason"] = "This installation has no matching local approval. Chain-carried approval is not execution permission; review and approve locally."
            return result
        Timechain, _ = _native()
        tc = Timechain(root)
        genesis = next(tc.iter_rings())
        expected = {"root": _identity(root), "genesisHash": genesis["ring_hash"],
                    "sha256": source["sha256"], "environmentSha256": source["environmentSha256"],
                    **_runtime(manifest["engineDirectory"])}
        if any(manifest.get(k) != v for k, v in expected.items()):
            result["reason"] = "Source, dependencies, or agent identity changed; approve the current digest locally."
            return result
        receipt = next((r for r in tc.iter_rings() if r["index"] == manifest.get("ring")), None)
        if not receipt or receipt.get("ring_hash") != manifest.get("ringHash") or receipt.get("ring_type") != "operator-code-approval":
            raise ValueError("Approval has no matching chain receipt.")
        if any(receipt.get("payload", {}).get(k) != v for k, v in expected.items()):
            raise ValueError("Approval receipt does not match the current source.")
        names = receipt["payload"].get("declaredNames")
        if (not isinstance(names, list) or names != manifest.get("declaredNames") or len(names) > 1000
                or any(not isinstance(name, str) or not 1 <= len(name) <= 512 for name in names)):
            raise ValueError("Approval faculty names are invalid.")
        revoked = any(r["index"] > receipt["index"] and r.get("ring_type") == "operator-code-revocation"
                      for r in tc.iter_rings())
        result.update(approved=not revoked, executionNames=names,
                      runtimeBinding=_hash(_canonical({k: expected[k] for k in ("engineDirectory", "runtimeSha256")})),
                      reason="Locally approved source, runtime and dependencies match." if not revoked else "Local code approval was revoked.")
        return result
    except (OSError, ValueError, SyntaxError, KeyError, StopIteration, TypeError):
        result.update(approved=False, reason="Local operator source or approval is invalid; inspect it locally.")
        return result


def approve_source(root, sha256, confirmed=False, names=None):
    if confirmed is not True:
        raise ValueError("Explicit local --confirm is required after reviewing the source and its imports.")
    root = _root(root)
    source = _source(root)
    if source is None or sha256 != source["sha256"]:
        raise ValueError("Supply the exact SHA-256 of the current active_ops.py.")
    names = source["declaredNames"] if names is None else names
    if (not isinstance(names, list) or not 1 <= len(names) <= 1000
            or any(not isinstance(name, str) or not name.strip() or len(name) > 512 for name in names)):
        raise ValueError("Approval requires named faculty operators; use --names for a dynamic OPS mapping.")
    names = list(dict.fromkeys(names))
    _trust_record_path(root, create=True)
    Timechain, epochs = _native()
    tc = Timechain(root)
    if not tc.verify()[0] or not epochs.check_epoch(root)[0] or (tc.dir / "LOCKED").exists() or (tc.dir / "PAUSED").exists():
        raise ValueError("The selected chain must verify and be active before code approval.")
    genesis = next(tc.iter_rings())
    payload = {"root": _identity(root), "genesisHash": genesis["ring_hash"],
               "sha256": source["sha256"], "environmentSha256": source["environmentSha256"],
               **_runtime(Path(sys.modules[Timechain.__module__].__file__).resolve().parent),
               "summary": "Local user explicitly approved the exact operator source and its local Python dependencies. Execution uses user OS permissions.",
               "localUserConfirmed": True, "declaredNames": names}
    ring = tc.seal("operator-code-approval", payload, files=[source["path"]])
    from timechain import atomic_write_json
    manifest = {**payload, "ring": ring["index"], "ringHash": ring["ring_hash"]}
    atomic_write_json(tc.dir / "operator-approval.json", manifest)
    _save_local_approval(root, manifest)
    return {"approved": True, "sha256": source["sha256"], "ring": {"index": ring["index"], "hash": ring["ring_hash"]}}


def revoke_source(root, confirmed=False):
    if confirmed is not True:
        raise ValueError("Explicit local --confirm is required.")
    root = _root(root)
    local_record = _trust_record_path(root)
    Timechain, _ = _native()
    tc = Timechain(root)
    if not tc.verify()[0]:
        raise ValueError("The selected chain must verify.")
    ring = tc.seal("operator-code-revocation", {"summary": "Local user revoked operator execution approval."})
    local_record.unlink(missing_ok=True)
    return {"approved": False, "ring": {"index": ring["index"], "hash": ring["ring_hash"]}}


def materialize_source(root, sha256, confirmed=False):
    """Explicitly place one authenticated, exact donor module without loading it.

    Original native skills autoload active_ops.py on a later invocation, so this
    is an explicit local authorization to place executable code there. ChainChat
    additionally requires approve-code for its separate, bounded worker. Neither
    a transported donor approval nor materialization creates that approval.
    """
    if confirmed is not True:
        raise ValueError("Review the exact whole-module source and its imports, then confirm materialization. Original skills may autoload it on their next run.")
    root = _root(root)
    import portable_faculties as portable
    Timechain, _ = _native()
    tc = Timechain(root)
    with portable._lock(tc):
        portable._verified(root, writable=True)
        state = portable.verified_portability_state(root)
        artifacts = [artifact for imported in state.get("imports", [])
                     for artifact in imported.get("artifacts", [])
                     if artifact.get("kind") == "authored-module" and artifact.get("sha256") == sha256]
        sources = {artifact["text"].encode("utf-8") for artifact in artifacts if isinstance(artifact.get("text"), str)}
        if len(sources) != 1:
            raise ValueError("Select the exact SHA-256 of an authenticated, retained whole authored module.")
        source = next(iter(sources))
        if _hash(source) != sha256 or len(source) > MAX_SOURCE:
            raise ValueError("The retained module digest or size is invalid.")
        ast.parse(source, filename="active_ops.py")  # syntax only; no imports/evaluation
        target = root / "active_ops.py"
        if target.exists() or target.is_symlink():
            raise ValueError("active_ops.py already exists; materialization never overwrites local source.")
        payload = {"sha256": sha256, "localUserConfirmed": True,
                   "summary": "Local user reviewed the exact retained module and authorized placing active_ops.py. Original skills may autoload it; ChainChat still requires separate code approval.",
                   "executionApprovedByChainChat": False, "nativeSkillMayAutoload": True}
        intent = tc._seal_locked("operator-code-materialization-intent", payload)
        temporary = root / (".operator-materialize-" + os.urandom(8).hex() + ".bin")
        created, installed = False, False
        try:
            with temporary.open("xb") as stream:
                created = True
                stream.write(source); stream.flush(); os.fsync(stream.fileno())
            # An atomic no-replace hard link avoids both partially visible source
            # and POSIX rename's overwrite behavior. Unsupported filesystems fail
            # before installing code; the user can inspect the retained artifact.
            os.link(temporary, target)
            installed = True
            temporary.unlink()
            ring = tc._seal_locked("operator-code-materialization", {**payload,
                    "intentRing": intent["index"], "intentHash": intent["ring_hash"]}, files=[target])
        except Exception:
            if installed:
                lock = tc.dir / "LOCKED"
                try:
                    with lock.open("xb") as stream:
                        stream.write(_canonical({"source": "operator-materialization", "sha256": sha256,
                            "reason": "Source placement needs recovery review; its final receipt did not finish."}))
                        stream.flush(); os.fsync(stream.fileno())
                except FileExistsError:
                    pass
            raise
        finally:
            if created:
                temporary.unlink(missing_ok=True)
    return {"materialized": True, "sha256": sha256, "source": "active_ops.py",
            "approved": False, "requiresChainChatApproval": True, "nativeSkillMayAutoload": True,
            "ring": {"index": ring["index"], "hash": ring["ring_hash"]}}


def run_approved(root, names, text, context="", timeout=10):
    root = _root(root)
    names = list(dict.fromkeys(names))
    status = inspect_source(root)
    if not status.get("approved") or not names:
        return {"computed": {}, "failures": {}, "status": status}
    # Approval of a module does not authorize loading it for unrelated lenses.
    names = [name for name in names if name in status.get("executionNames", [])]
    if not names:
        return {"computed": {}, "failures": {}, "status": status}
    source = _source(root)
    manifest = json.loads((root / "chain" / "operator-approval.json").read_text(encoding="utf-8"))
    runtime = _runtime(manifest["engineDirectory"])
    if _hash(_canonical(runtime)) != status["runtimeBinding"]:
        return {"computed": {}, "failures": {name: "Approved runtime changed; review it locally." for name in names}, "status": status}
    request = {"root": str(root), "source": base64.b64encode(source["bytes"]).decode("ascii"),
               "sha256": status["sha256"], "environmentSha256": status["environmentSha256"],
               **runtime, "names": names, "text": text, "context": context}
    raw = _canonical(request)
    if len(raw) > MAX_INPUT:
        return {"computed": {}, "failures": {name: "Operator input exceeds the bounded worker limit." for name in names}, "status": status}
    env = {k: v for k, v in os.environ.items() if k.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATHEXT"}}
    env.update(PYTHONIOENCODING="utf-8", PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
    child = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "--worker"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=root, env=env,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    buffers, overflow = {}, threading.Event()
    def read_stream(label, stream):
        chunks, size = [], 0
        while True:
            part = stream.read(65536)
            if not part:
                break
            size += len(part)
            if size > MAX_OUTPUT:
                overflow.set()
                child.kill()
                break
            chunks.append(part)
        buffers[label] = b"".join(chunks)
    readers = [threading.Thread(target=read_stream, args=(label, stream), daemon=True)
               for label, stream in (("out", child.stdout), ("err", child.stderr))]
    for thread in readers:
        thread.start()
    try:
        child.stdin.write(raw)
        child.stdin.close()
        child.wait(timeout=max(0.1, min(float(timeout), 30)))
        for thread in readers:
            thread.join(timeout=1)
        if overflow.is_set() or child.returncode != 0:
            raise ValueError("Operator worker failed or exceeded its output limit.")
        value = json.loads(buffers.get("out", b""))
        if not isinstance(value.get("computed"), dict) or not isinstance(value.get("failures"), dict):
            raise ValueError("Invalid worker result.")
        if _environment(root) != status["environmentSha256"] or _runtime(runtime["engineDirectory"]) != runtime:
            raise ValueError("Operator dependencies changed during execution.")
        return {**value, "status": status}
    except (ValueError, OSError, subprocess.TimeoutExpired):
        child.kill()
        child.wait()
        return {"computed": {}, "failures": {name: "Approved operator failed, timed out, changed, or returned invalid data; inspect it locally." for name in names}, "status": status}
    finally:
        for thread in readers:
            thread.join(timeout=1)
        for stream in (child.stdout, child.stderr):
            stream.close()


class _BoundedSilence(io.TextIOBase):
    def __init__(self):
        self.size = 0
    def write(self, text):
        self.size += len(text.encode("utf-8"))
        if self.size > MAX_OUTPUT:
            raise ValueError("Operator diagnostics exceeded the limit.")
        return len(text)


def _worker():
    data = json.loads(sys.stdin.buffer.read(MAX_INPUT + 1))
    root = _root(data["root"])
    source = base64.b64decode(data["source"], validate=True)
    if (_hash(source) != data["sha256"] or _environment(root) != data["environmentSha256"]
            or _runtime(data["engineDirectory"])["runtimeSha256"] != data["runtimeSha256"]):
        raise ValueError("Approved source changed.")
    sys.path.insert(0, data["engineDirectory"])
    sys.path.append(str(root))
    # Preserve a conventional module identity for recursive/local imports.
    module = types.ModuleType("active_ops")
    module.__file__ = str(root / "active_ops.py")
    sys.modules["active_ops"] = module
    computed, failures = {}, {}
    with contextlib.redirect_stdout(_BoundedSilence()), contextlib.redirect_stderr(_BoundedSilence()):
        exec(compile(source, module.__file__, "exec"), module.__dict__)
        ops = getattr(module, "OPS", {})
        if not isinstance(ops, dict):
            raise ValueError("Approved module must expose an OPS mapping.")
        for name in data["names"]:
            op = ops.get(name)
            if not callable(op):
                failures[name] = "The approved module has no callable for this faculty."
                continue
            try:
                value = op(data["text"], data.get("context", ""))
                encoded = json.dumps(value, allow_nan=False, ensure_ascii=False)
                if not isinstance(value, dict) or len(encoded.encode("utf-8")) > MAX_OUTPUT // 2:
                    raise ValueError("Invalid operator output.")
                computed[name] = value
            except Exception:
                failures[name] = "The approved faculty operator failed or returned invalid data."
    result = _canonical({"computed": computed, "failures": failures})
    if len(result) > MAX_OUTPUT:
        raise ValueError("Combined operator output exceeded the limit.")
    sys.stdout.buffer.write(result)


if __name__ == "__main__" and sys.argv[1:] == ["--worker"]:
    try:
        _worker()
    except BaseException:
        sys.exit(2)
