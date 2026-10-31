# macOS and Linux setup

The macOS ZIP contains executable **Install ChainChat.command**. Extract it and
double-click that file. The Linux tar.gz contains executable **Install
ChainChat.sh**; extract it and use the file manager's **Run as Program** action.
A direct `.run` is also supplied for shell-oriented Linux installations. Desktop
policies differ: a downloaded script may require the normal execute/launch
confirmation. These packages are unsigned and macOS notarization is not claimed.
Setup never removes quarantine flags or bypasses Gatekeeper.

Both packages detect ARM64 or x64 and download exact SHA-256-pinned Node
26.13.0 and portable CPython 3.12.16 runtimes. Python comes from the reviewed
Astral python-build-standalone 20261026 release. No system Node/Python, Homebrew,
pip package, sudo, system service or PATH modification is needed. Initial setup
requires Internet access and curl or wget. Runtime licenses/notices remain in the
installed upstream archives.

Supported binary baselines follow the pinned Node release: **macOS 13.5+**, and
**Linux kernel 4.18+/glibc 2.28+** on ARM64/x64. Alpine/musl and 32-bit Linux are
not claimed. The installer downloads prebuilt runtimes; it does not install
compiler toolchains. Use a filesystem supporting normal POSIX permissions,
executable files and symlinks. Existing group/world-writable installation roots
are refused rather than trusted with private local control credentials.

Default locations are:

- macOS: `~/Library/Application Support/CypherTempre/ChainChat`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/CypherTempre/ChainChat`

The application, portable runtimes and immutable releases live under that private
per-user root; `data/` is persistent. Existing external Timechains remain at
their selected paths. macOS setup creates a local app in `~/Applications`;
Linux creates a user application-menu entry. It opens the authenticated local
chat with OpenClaw and PoI included. Model/API selection, wallet verification and
fresh-versus-existing chain selection remain explicit user choices.

The Python front door waits for the private owned-runtime status and supports
relaunch without replacing a live matching runtime. It does not report success
merely because Node was spawned, and it never kills another program to obtain a
port. Quiet CI mode reports a nonzero failure/result file; desktop launches show
a safe error where the OS's dialog tools are available. Logs stay in the private
installation. Quitting the browser does not stop the local runtime.

`current.json` and `previous.json` select immutable releases. Setup verifies its
source ZIP, exact dependency lockfiles, native engine commitments and installed
runtime before activation. Repeating setup checks existing source bytes rather
than overwriting a modified release. Failed candidates retain the old pointer.
`launcher.py --rollback --install-root ...` switches to the checked previous
release without deleting data. This is release rollback, not a reversal of chain
mutations or an arbitrary schema downgrade.

## Build from a reviewed application archive

From the application directory:

```sh
python3 installer/build_posix.py --archive /reviewed/cypher-tempre-chat-v0.8.0.zip --output-dir /reviewed/setup --platform all
```

The builder reads bootstrap/installer sources and runtime pins from that ZIP,
not an unstaged source file. It emits macOS ZIP, Linux tar.gz, optional Linux
`.run`, JSON build manifests and SHA-256 sidecars. Each operating-system package
contains both architecture selections. Runtime pins are in
`openclaw/upstream-lock.json`; the official Node SHASUMS and Astral release asset
digest metadata were checked when selecting them.

## Isolated acceptance

Use a fresh test directory through the included harness. It creates shortcuts
only in a synthetic HOME/XDG directory, briefly starts a private local runtime
with no browser and uses synthetic native-chain data, then authenticates shutdown:

```sh
python3 installer/acceptance_posix.py --installer /reviewed/setup/CypherTempre-ChainChat-Setup-0.8.0-linux.tar.gz --work-root /var/tmp/chainchat-acceptance
```

Use the macOS ZIP path on a macOS runner. Optional `--cache-dir` reuses only
hash-matching upstream archives. Acceptance covers fresh/repeat install, native
verification, preserved data, executable desktop shortcuts in a synthetic home,
actual OpenClaw readiness and native settings RPC, same-PID relaunch,
occupied-port failure, bootstrap/rotating resume, read-only auditing, modified
source rejection and rollback pointer selection. A successful installer test
does not establish model answer quality or eliminate the documented upstream
dependency risks. Architecture/platform support is reported according to actual
native or CI runs; Windows cannot validate execution of a macOS binary.
