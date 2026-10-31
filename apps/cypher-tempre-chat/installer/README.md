# Windows installer

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

Setup creates a Start Menu launch shortcut and a previous-version shortcut. The
launcher starts the selected release's gateway and UI through
`openclaw/launcher.mjs`. The first installation needs Internet access to download
the pinned runtimes and locked npm packages. A failed check keeps the previously
selected release; `install.log` remains for local diagnosis. Re-run a repaired
installer to retry. Incomplete releases are retained rather than silently
overwritten. There is no automatic deletion of old releases or user data.

The source-built executable is **not Authenticode-signed**. Distribution signing
requires a publisher certificate and is separate from the included SHA-256 and
dependency-integrity checks. Do not describe it as a signed installer.
The builder emits an `.exe.sha256` checksum and `.exe.json` release manifest
beside the executable.

## Build

Build on Windows after producing the sanitized Git-based application ZIP:

```powershell
python installer/build_windows.py --archive C:\reviewed\cypher-tempre-chat-v0.7.0.zip --output C:\reviewed\CypherTempre-ChainChat-Setup-0.7.0-windows-x64.exe
```

The .NET Framework compiler consumes the C# source, Windows manifest and font
from that reviewed ZIP. There is no compiler download or third-party installer
toolchain. Runtime versions, URLs and SHA-256 commitments
live in `openclaw/upstream-lock.json`; the OpenClaw npm lockfile must match its
exact version and integrity.

## Isolated acceptance run

Use a dedicated empty test directory, suppress launch/shortcuts, and capture the
result without touching the current user's actual installation:

```powershell
.\CypherTempre-ChainChat-Setup-0.7.0-windows-x64.exe --quiet --install-root C:\test\chainchat-install --no-launch --no-shortcuts --result-file C:\test\install-result.json
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
through its authenticated control, rejects a tampered candidate, and exercises
the rollback path. The test installation is retained for inspection.

Only Windows x64 has an installer in this release. Source deployment on other
platforms still needs their supported Node/Python runtimes; no untested macOS or
Linux one-click installer is claimed.
