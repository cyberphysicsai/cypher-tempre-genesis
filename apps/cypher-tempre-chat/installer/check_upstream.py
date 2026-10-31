#!/usr/bin/env python3
"""Check exact local pin consistency, optionally report upstream npm releases.

This never installs packages, edits pins, merges source, starts a gateway or
accesses provider credentials. An available release is a review candidate.
"""
import argparse
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def local_state(root=ROOT):
    pins = json.loads((root / "openclaw/upstream-lock.json").read_text(encoding="utf-8"))
    package = json.loads((root / "openclaw/runtime/package.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "openclaw/runtime/package-lock.json").read_text(encoding="utf-8"))
    expected = pins["openclaw"]
    entry = lock.get("packages", {}).get("node_modules/openclaw", {})
    if package.get("dependencies", {}).get("openclaw") != expected["version"] or entry.get("version") != expected["version"] or entry.get("integrity") != expected["integrity"] or entry.get("resolved") != expected["source"]:
        raise ValueError("OpenClaw runtime manifest/lockfile/pin consistency check failed.")
    return {"consistent": True, "pinnedVersion": expected["version"], "pinnedIntegrity": expected["integrity"],
            "upstreamSourcePatched": False, "automaticInstall": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--online", action="store_true", help="Read official npm metadata to report an update candidate")
    args = parser.parse_args()
    result = local_state()
    if args.online:
        request = urllib.request.Request("https://registry.npmjs.org/openclaw/latest", headers={"User-Agent": "Cypher-Tempre-Upstream-Check"})
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("Upstream metadata exceeds its limit.")
        latest = json.loads(raw)
        result.update(candidateVersion=latest["version"], candidateIntegrity=latest["dist"]["integrity"],
                      differs=latest["version"] != result["pinnedVersion"],
                      nextStep="Review upstream notes, update exact pins in a branch, run compatibility/enforcement/installer checks, then publish.")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
