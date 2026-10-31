#!/usr/bin/env python3
"""Build a Windows x64 per-user installer from a reviewed source ZIP.

The compiler is the Windows .NET Framework compiler. The application and exact
runtime pins are embedded; no build-time package installation or credentials are
needed. Runtime downloads are hash-verified before extraction/execution.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tempfile
import zipfile

PRODUCT = Path(__file__).resolve().parents[1]
MAX_ARCHIVE = 1024 * 1024 * 1024
EXCLUDED_PARTS = {".git", ".local", "node_modules", "__pycache__", "chain", "tasks"}


def inspect_payload(path: Path):
    if not path.is_file() or path.stat().st_size > MAX_ARCHIVE:
        raise ValueError("A bounded reviewed source ZIP is required.")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        files = [entry for entry in entries if not entry.is_dir()]
        if not files or len(entries) > 100000 or sum(entry.file_size for entry in entries) > 4 * 1024**3:
            raise ValueError("The source ZIP has an invalid file count.")
        candidates = [entry.filename for entry in files if entry.filename == "package.json" or entry.filename.endswith("/package.json")]
        candidates = [name for name in candidates if name.count("/") <= 1]
        if len(candidates) != 1:
            raise ValueError("The archive must have exactly one application root.")
        package_name = candidates[0]
        prefix = package_name.removesuffix("package.json")
        seen = set()
        for entry in entries:
            name = entry.orig_filename
            parts = PurePosixPath(name).parts
            if (not name.startswith(prefix) or "\\" in name or name.startswith("/") or ":" in name
                    or ".." in parts or any(part in EXCLUDED_PARTS or part.startswith(".env") for part in parts)
                    or ((entry.external_attr >> 16) & 0o170000) == 0o120000):
                raise ValueError("The source ZIP contains an unsafe/private path: " + name)
            if name.casefold() in seen:
                raise ValueError("The source ZIP has duplicate Windows paths.")
            seen.add(name.casefold())
        package = json.loads(archive.read(package_name))
        if package.get("name") != "cypher-tempre-chat":
            raise ValueError("The archive is not the ChainChat application.")
        if not isinstance(package.get("version"), str) or not package["version"]:
            raise ValueError("The application version is missing.")
        required = ["server.mjs", "engine_bridge.py", "openclaw/launcher.mjs", "openclaw/upstream-lock.json",
                    "openclaw/runtime/package.json", "openclaw/runtime/package-lock.json",
                    "installer/windows-installer.cs", "installer/windows.manifest",
                    "public/fonts/orbitron/Orbitron-Variable.ttf"]
        if any(prefix + name not in archive.namelist() for name in required):
            raise ValueError("The reviewed archive is missing the OpenClaw runtime/launcher/lockfiles.")
        pins = json.loads(archive.read(prefix + "openclaw/upstream-lock.json"))
        runtime = json.loads(archive.read(prefix + "openclaw/runtime/package.json"))
        lock = json.loads(archive.read(prefix + "openclaw/runtime/package-lock.json"))
        expected = pins["openclaw"]
        installed = lock.get("packages", {}).get("node_modules/openclaw", {})
        if runtime.get("dependencies", {}).get("openclaw") != expected["version"] or installed.get("version") != expected["version"] or installed.get("integrity") != expected["integrity"] or installed.get("resolved") != expected["source"]:
            raise ValueError("The OpenClaw dependency and lockfile do not match upstream-lock.json.")
        overrides = pins.get("dependencyOverrides", {})
        if runtime.get("overrides", {}) != overrides or any(
                lock.get("packages", {}).get("node_modules/" + name, {}).get("version") != version
                for name, version in overrides.items()):
            raise ValueError("The dependency overrides and lockfile do not match upstream-lock.json.")
        return package, prefix, pins


def build(archive: Path, output: Path):
    if os.name != "nt":
        raise RuntimeError("Build the Windows installer on Windows with the .NET Framework compiler.")
    archive, output = archive.resolve(), output.resolve()
    if output.exists():
        raise ValueError("The installer output exists; use a new output filename.")
    package, prefix, pins = inspect_payload(archive)
    manifest = {"product": "cypher-tempre-chainchat", "version": package["version"],
                "payloadSha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "payloadPrefix": prefix,
                "openclawVersion": pins["openclaw"]["version"],
                "dependencyOverrides": pins.get("dependencyOverrides", {}),
                "node": pins["windowsX64"]["node"], "python": pins["windowsX64"]["python"]}
    compiler = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    if not compiler.is_file():
        raise RuntimeError("The Windows .NET Framework compiler is unavailable.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ct-installer-build-") as temporary:
        directory = Path(temporary).resolve()
        if not directory.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError("The build temporary directory is outside the system temporary directory.")
        manifest_file = directory / "manifest.json"
        manifest_file.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
        font_file = directory / "Orbitron.ttf"
        source_file = directory / "windows-installer.cs"
        windows_manifest = directory / "windows.manifest"
        with zipfile.ZipFile(archive) as packaged:
            font_file.write_bytes(packaged.read(prefix + "public/fonts/orbitron/Orbitron-Variable.ttf"))
            source_file.write_bytes(packaged.read(prefix + "installer/windows-installer.cs"))
            windows_manifest.write_bytes(packaged.read(prefix + "installer/windows.manifest"))
        arguments = [str(compiler), "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
            "/win32manifest:" + str(windows_manifest),
            "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll",
            "/reference:System.IO.Compression.dll", "/reference:System.IO.Compression.FileSystem.dll",
            "/resource:" + str(archive) + ",payload.zip", "/resource:" + str(manifest_file) + ",manifest.json", "/resource:" + str(font_file) + ",font.ttf",
            "/out:" + str(output), str(source_file)]
        compiled = subprocess.run(arguments, text=True, capture_output=True)
        if compiled.returncode:
            raise RuntimeError("Installer compilation failed:\n" + compiled.stdout + compiled.stderr)
    result = {"version": package["version"], "platform": "windows-x64", "installer": output.name,
              "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "bytes": output.stat().st_size,
              "payloadSha256": manifest["payloadSha256"], "openclawVersion": manifest["openclawVersion"],
              "dependencyOverrides": manifest["dependencyOverrides"],
              "nodeVersion": manifest["node"]["version"], "pythonVersion": manifest["python"]["version"],
              "authenticodeSigned": False, "requiresAdministrator": False, "networkNeededForFirstInstall": True}
    output.with_suffix(output.suffix + ".json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    output.with_suffix(output.suffix + ".sha256").write_text(result["sha256"] + "  " + output.name + "\n", encoding="ascii")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.archive, args.output)))


if __name__ == "__main__":
    main()
