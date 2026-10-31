#!/usr/bin/env python3
"""Run a real installer twice in an isolated root, check data and failure safety.

This briefly starts and stops the isolated installed launcher without opening a
browser. It creates no shortcuts, changes no actual per-user installation, and
uses no model API credentials. It leaves the test root for review.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
import urllib.request


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path)
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Windows installer acceptance runs on Windows only.")
    work = args.work_root.resolve()
    if work.exists() and any(work.iterdir()):
        parser.error("Choose a new empty isolated work directory.")
    work.mkdir(parents=True, exist_ok=True)
    target = work / "installation"
    installer = args.installer.resolve()
    if not installer.is_file():
        parser.error("Installer does not exist.")
    flags = [str(installer), "--quiet", "--install-root", str(target), "--no-launch", "--no-shortcuts"]
    if args.cache_dir:
        flags += ["--cache-dir", str(args.cache_dir.resolve())]

    def run(label, expect=0, extra=None):
        result = work / (label + ".json")
        command = flags + (extra or []) + ["--result-file", str(result)]
        completed = subprocess.run(command, timeout=5400, creationflags=subprocess.CREATE_NO_WINDOW)
        data = json.loads(result.read_text(encoding="utf-8"))
        if completed.returncode != expect or data.get("ok") is not (expect == 0):
            raise RuntimeError(label + " failed: " + json.dumps(data))
        return data

    first = run("first-install")
    active_file = target / "current.json"
    active = json.loads(active_file.read_text(encoding="utf-8"))
    release = Path(active["release"])
    if not release.resolve().is_relative_to(target) or not Path(active["data"]).resolve().is_relative_to(target):
        raise RuntimeError("Installed paths escaped the isolated root.")
    native_root = target / "data" / "agents" / "acceptance-agent"
    environment = {**os.environ, "CT_OPERATOR_TRUST_ROOT": str(target / "data/operator-approvals"),
                   "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}

    def engine(op, **fields):
        result = subprocess.run([active["python"], str(release / "engine_bridge.py")],
            input=json.dumps({"op": op, "root": str(native_root), **fields}), text=True,
            capture_output=True, env=environment, creationflags=subprocess.CREATE_NO_WINDOW, timeout=120)
        data = json.loads(result.stdout)
        if result.returncode or not data.get("ok"):
            raise RuntimeError("Installed native engine rejected fixture: " + json.dumps(data))
        return data

    initialized = engine("init", name="Isolated Installer Acceptance Agent")
    verified = engine("verify")
    chain_file = native_root / "chain/rings.jsonl"
    before_chain = digest(chain_file)
    sentinel = target / "data" / "preserved-user-state.json"
    sentinel.write_text('{"fixture":"preserve existing local data"}\n', encoding="utf-8")
    before_sentinel = digest(sentinel)
    second = run("repeat-install")
    if digest(chain_file) != before_chain or digest(sentinel) != before_sentinel:
        raise RuntimeError("An update rewrote existing chain or user data.")
    if not engine("verify").get("verified"):
        raise RuntimeError("Existing chain no longer verifies after update.")
    active_before = active_file.read_bytes()
    probe_environment = {**environment, "CT_CHAT_NO_BROWSER": "1", "CT_CHAT_PORT": "0"}
    owner_file = target / "data/runtime-owner.json"
    launched = subprocess.run([str(target / "ChainChat.exe"), "--launch", "--quiet", "--install-root", str(target),
        "--result-file", str(work / "launch-result.json")], env=probe_environment, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
    if launched.returncode:
        raise RuntimeError("Installed one-click launcher failed.")
    observed = None
    try:
        deadline = time.monotonic() + 90
        owner = None
        while time.monotonic() < deadline:
            try:
                owner = json.loads(owner_file.read_text(encoding="utf-8"))
                break
            except (OSError, ValueError):
                time.sleep(0.2)
        if owner is None:
            raise RuntimeError("Installed launcher did not become ready.")
        request = urllib.request.Request("http://127.0.0.1:" + str(owner["port"]) + "/launch", method="POST",
                                         headers={"Authorization": "Bearer " + owner["token"]})
        with urllib.request.urlopen(request, timeout=5) as response:
            ui = urllib.parse.urlsplit(json.load(response)["url"])
        if ui.scheme != "http" or ui.hostname != "127.0.0.1" or not ui.port:
            raise RuntimeError("Installed launcher returned an invalid local origin.")
        with urllib.request.urlopen("http://127.0.0.1:" + str(ui.port) + "/api/status", timeout=5) as response:
            observed = json.load(response)
        if observed.get("runtime", {}).get("backend") != "openclaw":
            raise RuntimeError("Installed UI did not select the actual OpenClaw backend.")
    finally:
        stopped = subprocess.run([active["node"], str(release / "openclaw/launcher.mjs"), "--stop"],
            env={**probe_environment, "CT_CHAT_DATA": active["data"], "CT_CHAT_PYTHON": active["python"],
                 "CT_OPENCLAW_MODULE": str(release / "openclaw/runtime/node_modules/openclaw")},
            capture_output=True, text=True, timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
        if stopped.returncode:
            raise RuntimeError("Owned runtime could not be stopped through its authenticated control.")
    deadline = time.monotonic() + 30
    while owner_file.exists() and time.monotonic() < deadline:
        time.sleep(0.2)
    if owner_file.exists():
        raise RuntimeError("Owned runtime left its live ownership record after shutdown.")
    app_file = release / "server.mjs"
    source = app_file.read_bytes()
    app_file.write_bytes(source + b"\n// changed acceptance fixture\n")
    try:
        held = run("tampered-source-held", expect=1)
        if active_file.read_bytes() != active_before or digest(chain_file) != before_chain or digest(sentinel) != before_sentinel:
            raise RuntimeError("A failed candidate changed the active release or existing data.")
    finally:
        app_file.write_bytes(source)
    rollback = run("rollback", extra=["--rollback"])
    if digest(chain_file) != before_chain or digest(sentinel) != before_sentinel:
        raise RuntimeError("Rollback rewrote existing data.")
    self_test = run("executable-self-test", extra=["--self-test"])
    report = {"installerSha256": digest(installer), "installedVersion": active["version"],
        "root": str(target), "firstInstall": first["ok"], "repeatInstall": second["ok"],
        "nativeEngineVerified": verified["verified"], "existingChainBytesPreserved": True,
        "userDataBytesPreserved": True, "tamperedCandidateHeld": not held["ok"],
        "activePointerPreservedOnFailure": True, "rollbackPreservedData": rollback["ok"],
        "executableSelfTest": self_test["ok"], "installedLauncherServedOpenclawMode": observed is not None,
        "ownedRuntimeStopped": True, "shortcutsCreated": False,
        "paidModelCalls": 0, "productionUserInstallationTouched": False}
    (work / "acceptance-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
