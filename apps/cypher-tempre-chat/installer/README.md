# ChainChat installers

Windows x64 setup is described below. macOS 13.5+ (Apple Silicon/Intel) and glibc
Linux (ARM64/x64) packages use the reviewed portable-runtime setup described in
[POSIX.md](POSIX.md). They include Python and Node automatically; system package
managers or sudo are not required. macOS ZIP contains an executable `.command`;
Linux tar.gz contains an executable `.sh`, with an optional direct `.run` file.
Normal OS confirmation/executable-file policies still apply. macOS signing and
notarization are not claimed.

Browser automation uses a separate ChainChat profile. Existing Chrome, Chromium
or Edge binaries are discovered from fixed local installation paths; personal
browser profiles are never adopted. If none is available, open **Settings →
Browser → Set up managed Chromium** after connecting your model and Timechain.
That explicit action runs the installed, lock-matched Playwright CLI to download
its selected Chromium revision into private `data/browser-runtime/` storage.
It does not install system packages or request administrator access. Linux still
needs the browser's normal system libraries; install those through your usual OS
administration process if the browser cannot start. Browser setup is optional
and separate from installing the local chat runtime.

## Windows x64

The Windows x64 setup executable installs ChainChat for the current user. It
embeds the reviewed application ZIP and downloads exact, hash-pinned Node.js and
CPython runtimes from their official HTTPS distribution hosts. It uses locked
`npm ci --ignore-scripts` installs for ChainChat and OpenClaw. No global Node or
Python installation, administrator access, registry setting, PATH change or
Windows service is needed.

The default location is `%LOCALAPPDATA%\CypherTempre\ChainChat`. Each application
release and its embedded Python are separate. `data/` holds persistent ChainChat
state, OpenClaw state and local operator approval authority; selected existing
Timechains stay at their original paths. Setup never deletes or rewrites those
directories. It checks the staged installation before changing `current.json`.

Custom Windows installation roots must be **120 characters or fewer**, after
resolving the full path. Setup rejects longer roots before creating installation
files: the pinned upstream model-catalog worker has a Windows temporary-path
length limit. Keep the default location or choose a shorter dedicated directory.
For Windows source runs, also keep `CT_CHAT_DATA` short rather than storing runtime
state beneath a deeply nested checkout; for example, set it to
`%LOCALAPPDATA%\CypherTempre\ChainChat-dev`. Preserve existing native state and
Timechains when diagnosing startup; deleting ownership leases is not a repair.

Setup creates a Start Menu launch shortcut and a previous-version shortcut. The
launcher starts the selected release's gateway and UI through
`openclaw/launcher.mjs` and opens the local application automatically. Users do
not start a separate bridge or install the skill, Node or Python themselves.
Setup waits for the owned runtime's authenticated readiness check before
reporting success; reopening the Start Menu shortcut reuses that running
instance. API/model selection, wallet verification, and choosing a new or
existing Timechain remain explicit user controls.
The first installation needs Internet access to download
the pinned runtimes and locked npm packages. A failed check keeps the previously
selected release; `install.log` remains for local diagnosis. Re-run a repaired
installer to retry. Incomplete releases are retained rather than silently
overwritten. There is no automatic deletion of old releases or user data.
If startup fails, including when another program holds the configured port,
setup shows a safe message pointing to `data/launcher.log`; quiet mode returns
nonzero JSON instead of reporting success. It never stops an unrelated program.

The source-built executable is **not Authenticode-signed**. Distribution signing
requires a publisher certificate and is separate from the included SHA-256 and
dependency-integrity checks. Do not describe it as a signed installer.
The builder emits an `.exe.sha256` checksum and `.exe.json` release manifest
beside the executable.

## Build

Build on Windows after producing the sanitized Git-based application ZIP:

```powershell
python installer/build_windows.py --archive C:\reviewed\cypher-tempre-chat-v0.9.0.zip --output C:\reviewed\CypherTempre-ChainChat-Setup-0.9.0-windows-x64.exe
```

The .NET Framework compiler consumes the C# source, Windows manifest and font
from that reviewed ZIP. There is no compiler download or third-party installer
toolchain. Runtime versions, URLs and SHA-256 commitments
live in `openclaw/upstream-lock.json`; the OpenClaw npm lockfile must match its
exact version and integrity.
Reviewed dependency overrides are also pinned there. The build checks the
manifest and lockfile agree, and setup checks their actual installed versions
before activation. These checks do not assert that every bundled upstream
dependency has no reported vulnerabilities.

## Isolated acceptance run

Use a dedicated empty test directory, suppress launch/shortcuts, and capture the
result without touching the current user's actual installation:

```powershell
.\CypherTempre-ChainChat-Setup-0.9.0-windows-x64.exe --quiet --install-root C:\test\chainchat-install --no-launch --no-shortcuts --result-file C:\test\install-result.json
```

`--cache-dir` may name a directory containing the exact official Node/CPython ZIP
filenames; the same pinned hashes are required. `--self-test --quiet` exercises
archive path and checksum guards without installing anything. `--rollback`
selects `previous.json`; it preserves all chain data and does not undo schema
changes made by an independently running native skill. Stop the active runtime
before switching releases.

For the complete isolated acceptance sequence, run `acceptance_windows.py` with
`--installer`, a new empty `--work-root`, and optionally `--cache-dir`. It installs
twice, verifies an existing synthetic chain and user-data sentinel remain
byte-identical, briefly starts the installed launcher with a random local port
and no browser, checks the OpenClaw backend status, stops only that owned runtime
through its authenticated control, confirms reopening reuses the same instance,
confirms an occupied port returns failure while preserving the unrelated
listener, rejects a tampered candidate, and exercises
the rollback path. The test installation is retained for inspection.
It also authenticates the local UI from the launch nonce, resumes the same
session with a rotated ticket, and rejects replay, hosted-origin and
missing-origin resume attempts. Test credentials stay in process memory.
The installed frontend policy must allow bootstrap and read-only audit before
wallet verification while keeping model operations behind the holdings gate.

macOS and Linux packages and their isolated native acceptance procedure are
described in [POSIX.md](POSIX.md). Platform execution support is established by
the corresponding native CI acceptance result.
