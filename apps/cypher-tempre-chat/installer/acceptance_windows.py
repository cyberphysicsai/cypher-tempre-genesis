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
import socket
import subprocess
import sys
import time
import urllib.error
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
    frontend_policy = """import { requiresHoldings } from './public/chainchat-display.js';
const bootstrap = ['/api/launch', '/api/local-resume', '/api/agents/discover', '/api/audit/read'];
if (bootstrap.some(route => requiresHoldings(route, {})))
  throw new Error('Local setup or read-only audit was gated before authentication');
if (!requiresHoldings('/api/chat', {}) || !requiresHoldings('/api/provider', {}))
  throw new Error('Model operations lost the holdings gate');
process.stdout.write(JSON.stringify({ bootstrapRequiresHoldings: false, modelOperationsRequireHoldings: true }));
"""
    frontend = subprocess.run([active["node"], "--input-type=module", "-e", frontend_policy],
        cwd=release, env=environment, capture_output=True, text=True, timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW)
    if frontend.returncode:
        raise RuntimeError("Installed frontend incorrectly gates bootstrap/audit or ungates model operations.")
    json.loads(frontend.stdout)

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
        "--result-file", str(work / "launch-result.json")], env=probe_environment, timeout=150, creationflags=subprocess.CREATE_NO_WINDOW)
    if launched.returncode:
        raise RuntimeError("Installed one-click launcher failed.")
    if not owner_file.exists():
        raise RuntimeError("Installed front door reported success before its runtime became ready.")
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
        local_origin = "http://127.0.0.1:" + str(ui.port)
        for asset in ("/", "/app.js", "/local-session.js"):
            with urllib.request.urlopen(local_origin + asset, timeout=10) as response:
                if response.status != 200 or not response.read(1024):
                    raise RuntimeError("An installed local UI asset is unavailable.")
        nonce = urllib.parse.parse_qs(ui.fragment).get("launch", [None])[0]
        if not isinstance(nonce, str) or len(nonce) != 64:
            raise RuntimeError("Installed launcher did not supply a bounded local bootstrap credential.")

        def local_post(route, fields, origin=local_origin, site="same-origin"):
            headers = {"Content-Type": "application/json"}
            if origin is not None:
                headers["Origin"] = origin
            if site is not None:
                headers["Sec-Fetch-Site"] = site
            request = urllib.request.Request(local_origin + route, data=json.dumps(fields).encode("utf-8"),
                                             method="POST", headers=headers)
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)

        def authenticated_state(bearer):
            request = urllib.request.Request(local_origin + "/api/state", headers={"Origin": local_origin,
                "Authorization": "Bearer " + bearer, "Sec-Fetch-Site": "same-origin"})
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)

        def held_resume(ticket, **headers):
            try:
                local_post("/api/local-resume", {"resumeTicket": ticket}, **headers)
            except urllib.error.HTTPError as rejected:
                status = rejected.code
                rejected.close()
                if status in (401, 403):
                    return
            raise RuntimeError("Installed local session granted a rejected resume request.")

        # Credentials remain in this test process's memory and are never reported.
        connected = local_post("/api/launch", {"nonce": nonce})
        if not all(isinstance(connected.get(key), str) and len(connected[key]) == 64 for key in ("token", "resumeTicket")):
            raise RuntimeError("Installed local UI could not authenticate automatically.")
        before_resume = authenticated_state(connected["token"])
        resumed = local_post("/api/local-resume", {"resumeTicket": connected["resumeTicket"]})
        if resumed.get("token") != connected["token"] or resumed.get("resumeTicket") == connected["resumeTicket"]:
            raise RuntimeError("Reload did not preserve the local session and rotate its resume credential.")
        held_resume(connected["resumeTicket"])
        held_resume(resumed["resumeTicket"], origin="https://cyphertempre.ai", site="cross-site")
        held_resume(resumed["resumeTicket"], origin=None, site=None)
        resumed_again = local_post("/api/local-resume", {"resumeTicket": resumed["resumeTicket"]})
        after_resume = authenticated_state(resumed_again.get("token", ""))
        if resumed_again.get("token") != connected["token"] or before_resume.get("provider") != after_resume.get("provider"):
            raise RuntimeError("Reload changed the local session or its model configuration.")
        relaunched = subprocess.run([str(target / "ChainChat.exe"), "--launch", "--quiet", "--install-root", str(target),
            "--result-file", str(work / "relaunch-result.json")], env=probe_environment, timeout=150,
            creationflags=subprocess.CREATE_NO_WINDOW)
        if relaunched.returncode or json.loads(owner_file.read_text(encoding="utf-8"))["pid"] != owner["pid"]:
            raise RuntimeError("Reopening ChainChat did not safely reuse the owned runtime.")
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
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen(1)
        conflict_result = work / "occupied-port-result.json"
        conflict = subprocess.run([str(target / "ChainChat.exe"), "--launch", "--quiet", "--install-root", str(target),
            "--result-file", str(conflict_result)], env={**probe_environment, "CT_CHAT_PORT": str(occupied.getsockname()[1])},
            timeout=150, creationflags=subprocess.CREATE_NO_WINDOW)
        held_start = json.loads(conflict_result.read_text(encoding="utf-8"))
        if conflict.returncode != 1 or held_start.get("ok") is not False or owner_file.exists():
            raise RuntimeError("An occupied port was incorrectly reported as a successful launch.")
        if str(target / "data/launcher.log") not in held_start.get("message", "") or "Bearer" in held_start.get("message", ""):
            raise RuntimeError("Startup failure did not return a safe local diagnostic path.")
        # The unrelated listener is still owned by this fixture and must remain live.
        with socket.create_connection(occupied.getsockname(), timeout=2) as client:
            connection, _ = occupied.accept()
            with connection:
                client.sendall(b"held")
                if connection.recv(4) != b"held":
                    raise RuntimeError("Startup failure interfered with the unrelated listener.")
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
        "launcherWaitedForAuthenticatedReady": True, "relaunchReusedRuntime": True, "occupiedPortReportedFailure": True,
        "localUiAutomaticallyAuthenticated": True, "localRefreshPreservedSession": True,
        "installedUiAssetsServed": True,
        "frontendBootstrapDoesNotRequireHoldings": True, "frontendModelHoldingsGatePreserved": True,
        "localResumeRejectedReplay": True, "localResumeRejectedHostedOrigin": True,
        "localResumeRequiredExplicitOrigin": True,
        "ownedRuntimeStopped": True, "shortcutsCreated": False,
        "paidModelCalls": 0, "productionUserInstallationTouched": False}
    (work / "acceptance-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
