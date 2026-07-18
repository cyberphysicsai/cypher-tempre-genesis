#!/usr/bin/env python3
# Copyright (c) 2026 cyberphysicsai. MIT License.
"""Wire the Cypher Tempre self-model into Hermes' shell-hook system.

Hermes (unlike Claude Code / Codex) has no auto-discovered hook directory: hooks
are declared in ~/.hermes/config.yaml under a `hooks:` block and run as
subprocesses on lifecycle events (agent/shell_hooks.py). This installer merges the
three Cypher Tempre hooks into that config with ABSOLUTE paths, idempotently, and
marks the wrapper scripts executable. Re-running is safe — it updates in place.

    python3 hermes/install_hooks.py            # merge into ~/.hermes/config.yaml
    python3 hermes/install_hooks.py --print    # print the block, write nothing
    python3 hermes/install_hooks.py --config /path/to/config.yaml
    python3 hermes/install_hooks.py --check     # report wiring status, exit 0/1

Design: FAIL-LOUD (unlike the hooks themselves, which fail open). A misconfigured
install must be visible, so this reports precisely what it did or why it could not.
It NEVER edits config.yaml without a timestamped .bak backup first.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent          # .../cypher-tempre-self-model/hermes
SKILL_DIR = HERE.parent                          # .../cypher-tempre-self-model
SKILLS_ROOT = SKILL_DIR.parent                   # dir that CONTAINS the skill

EVENTS = ("pre_llm_call", "post_llm_call", "subagent_stop")
WRAPPERS = {
    "pre_llm_call": HERE / "pre_llm_call.sh",
    "post_llm_call": HERE / "post_llm_call.sh",
    "subagent_stop": HERE / "subagent_stop.sh",
}
DEFAULT_TIMEOUT = 30
MARKER = "cypher-tempre-self-model/hermes/"   # identifies our entries on re-run


def _default_config_path() -> Path:
    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    return home / "config.yaml"


def _desired_hooks() -> dict:
    """The hooks sub-dict we want present, with absolute wrapper paths."""
    return {
        ev: [{"command": str(WRAPPERS[ev]), "timeout": DEFAULT_TIMEOUT}]
        for ev in EVENTS
    }


def _chmod_wrappers() -> list[str]:
    done = []
    for p in WRAPPERS.values():
        if p.is_file():
            mode = p.stat().st_mode
            p.chmod(mode | 0o111)  # +x for u/g/o where readable
            done.append(p.name)
    return done


def _print_block() -> None:
    hb = _desired_hooks()
    print("# Merge into ~/.hermes/config.yaml — Cypher Tempre Hermes hooks")
    print("hooks:")
    for ev in EVENTS:
        entry = hb[ev][0]
        print(f"  {ev}:")
        print(f"    - command: \"{entry['command']}\"")
        print(f"      timeout: {entry['timeout']}")
    print("hooks_auto_accept: true  # needed for non-TTY (gateway/cron) registration")


def _load_yaml(path: Path):
    try:
        import yaml  # type: ignore
    except ImportError:
        return None, "pyyaml-missing"
    if not path.is_file():
        return {}, None
    try:
        with path.open() as fh:
            data = yaml.safe_load(fh) or {}
        if not isinstance(data, dict):
            return None, "config-not-a-mapping"
        return data, None
    except Exception as exc:  # pragma: no cover - defensive
        return None, f"parse-error: {exc}"


def _hooks_present(cfg: dict) -> dict:
    """Which of our events are already wired to OUR wrapper (by MARKER)."""
    present = {}
    hooks = cfg.get("hooks") if isinstance(cfg, dict) else None
    if not isinstance(hooks, dict):
        return present
    for ev in EVENTS:
        entries = hooks.get(ev)
        if isinstance(entries, list):
            for e in entries:
                if isinstance(e, dict) and MARKER in str(e.get("command", "")):
                    present[ev] = e.get("command")
                    break
    return present


def cmd_check(config_path: Path) -> int:
    missing_wrappers = [p.name for p in WRAPPERS.values() if not p.is_file()]
    if missing_wrappers:
        print(f"FAIL: wrapper scripts missing: {', '.join(missing_wrappers)}")
        return 1
    cfg, err = _load_yaml(config_path)
    if err == "pyyaml-missing":
        print("UNKNOWN: pyyaml not installed; cannot parse config.yaml. "
              "Install pyyaml or wire hooks manually from hermes/config.hooks.yaml.")
        return 1
    if err:
        print(f"FAIL: {config_path}: {err}")
        return 1
    present = _hooks_present(cfg)
    for ev in EVENTS:
        status = "WIRED" if ev in present else "MISSING"
        print(f"  {ev:16s} {status}")
    aa = cfg.get("hooks_auto_accept")
    print(f"  hooks_auto_accept: {aa!r}"
          + ("" if aa else "  (set true for non-TTY gateway/cron registration)"))
    ok = len(present) == len(EVENTS)
    print("OK: all Cypher Tempre Hermes hooks are wired." if ok
          else "INCOMPLETE: run install_hooks.py (no args) to wire the missing hooks.")
    return 0 if ok else 1


def cmd_install(config_path: Path, auto_accept: bool) -> int:
    missing_wrappers = [str(p) for p in WRAPPERS.values() if not p.is_file()]
    if missing_wrappers:
        print("FAIL: cannot install — wrapper scripts not found:")
        for m in missing_wrappers:
            print(f"  {m}")
        return 1

    chmodded = _chmod_wrappers()

    try:
        import yaml  # type: ignore
    except ImportError:
        print("pyyaml is not installed, so config.yaml cannot be safely merged.")
        print("Either `pip install pyyaml` and re-run, or paste this block into "
              f"{config_path} by hand:\n")
        _print_block()
        return 1

    cfg, err = _load_yaml(config_path)
    if err and err != "pyyaml-missing":
        print(f"FAIL: {config_path}: {err} (refusing to overwrite a config I can't parse)")
        return 1
    if cfg is None:
        cfg = {}

    # Backup before any write.
    if config_path.is_file():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = config_path.with_suffix(config_path.suffix + f".bak-{stamp}")
        shutil.copy2(config_path, backup)
        print(f"backup: {backup}")

    hooks = cfg.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
    desired = _desired_hooks()
    for ev in EVENTS:
        entries = hooks.get(ev)
        if not isinstance(entries, list):
            entries = []
        # Drop any prior CT entry for this event, then append the fresh one
        # (idempotent + path-refreshing across moves/upgrades).
        entries = [e for e in entries
                   if not (isinstance(e, dict) and MARKER in str(e.get("command", "")))]
        entries.extend(desired[ev])
        hooks[ev] = entries
    cfg["hooks"] = hooks
    if auto_accept:
        cfg["hooks_auto_accept"] = True

    config_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = config_path.with_suffix(config_path.suffix + ".ct-tmp")
    with tmp.open("w") as fh:
        yaml.safe_dump(cfg, fh, sort_keys=False, default_flow_style=False)
    os.replace(tmp, config_path)

    print(f"wired 3 Cypher Tempre hooks into: {config_path}")
    if chmodded:
        print(f"chmod +x: {', '.join(chmodded)}")
    print("events: " + ", ".join(EVENTS))
    if auto_accept:
        print("hooks_auto_accept: true (non-TTY registration enabled)")
    else:
        print("NOTE: first CLI run will prompt to approve each hook. For gateway/cron "
              "set hooks_auto_accept: true or export HERMES_ACCEPT_HOOKS=1.")
    print("verify with:  hermes hooks list   &&   hermes hooks doctor")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Wire Cypher Tempre into Hermes shell hooks.")
    ap.add_argument("--config", type=Path, default=None,
                    help="Path to config.yaml (default: $HERMES_HOME/config.yaml or ~/.hermes/config.yaml)")
    ap.add_argument("--print", dest="do_print", action="store_true",
                    help="Print the hooks block and exit (write nothing).")
    ap.add_argument("--check", action="store_true",
                    help="Report whether the hooks are wired; exit 0 if complete, 1 otherwise.")
    ap.add_argument("--no-auto-accept", action="store_true",
                    help="Do not set hooks_auto_accept: true (approve interactively instead).")
    args = ap.parse_args(argv)

    config_path = (args.config or _default_config_path()).expanduser()

    if args.do_print:
        _print_block()
        return 0
    if args.check:
        return cmd_check(config_path)
    return cmd_install(config_path, auto_accept=not args.no_auto_accept)


if __name__ == "__main__":
    sys.exit(main())
