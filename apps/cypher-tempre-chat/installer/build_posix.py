#!/usr/bin/env python3
"""Build reviewed macOS ZIP and Linux tar/run installers on any build host."""
from __future__ import annotations
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import shlex
import tarfile
import urllib.parse
import zipfile

from build_windows import inspect_payload


def gz_tar(files):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode='wb', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for name, (content, mode) in sorted(files.items()):
                member = tarfile.TarInfo(name)
                member.size, member.mode, member.mtime = len(content), mode, 0
                member.uid = member.gid = 0
                archive.addfile(member, io.BytesIO(content))
    return output.getvalue()


def build(source, directory, platform_name):
    source, directory = Path(source).resolve(), Path(directory).resolve()
    package, prefix, pins = inspect_payload(source)
    if platform_name not in {'darwin', 'linux'}:
        raise ValueError('Choose darwin or linux.')
    with zipfile.ZipFile(source) as archive:
        common = archive.read(prefix + 'installer/posix_install.py')
        bootstrap = archive.read(prefix + 'installer/posix_bootstrap.sh').decode('utf-8')
    runtimes = {key: value for key, value in pins.get('posix', {}).items() if key.startswith(platform_name + '-')}
    if set(runtimes) != {platform_name + '-arm64', platform_name + '-x64'}:
        raise ValueError('Both exact architecture runtime pins are required.')
    cases = []
    for key, pair in sorted(runtimes.items()):
        for name in ('node', 'python'):
            pin = pair[name]
            parsed = urllib.parse.urlsplit(pin['url'])
            if parsed.scheme != 'https' or parsed.hostname not in {'nodejs.org', 'github.com'} or not re.fullmatch('[a-f0-9]{64}', pin['sha256']):
                raise ValueError('Runtime source or SHA-256 pin is invalid.')
        python = pair['python']
        filename = Path(urllib.parse.unquote(urllib.parse.urlsplit(python['url']).path)).name
        cases.append(key + ') python_url=' + shlex.quote(python['url']) + '; python_sha=' +
            shlex.quote(python['sha256']) + '; python_name=' + shlex.quote(filename) + ' ;;')
    manifest = {'product': 'cypher-tempre-chainchat', 'version': package['version'],
        'platform': platform_name, 'payloadPrefix': prefix,
        'payloadSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'runtimes': runtimes,
        'openclawVersion': pins['openclaw']['version'], 'dependencyOverrides': pins.get('dependencyOverrides', {})}
    bundle = gz_tar({'manifest.json': (json.dumps(manifest, sort_keys=True).encode(), 0o600),
        'payload.zip': (source.read_bytes(), 0o600), 'posix_install.py': (common, 0o600)})
    script = bootstrap.replace('@PLATFORM@', platform_name).replace('@RUNTIME_CASES@', '\n'.join(cases)).replace(
        '@BUNDLE_SHA256@', hashlib.sha256(bundle).hexdigest()).encode('utf-8')
    script += base64.encodebytes(bundle)
    system = 'macos' if platform_name == 'darwin' else 'linux'
    stem = 'CypherTempre-ChainChat-Setup-' + package['version'] + '-' + system
    readme = ("Cypher Tempre ChainChat " + package['version'] + "\n\n" +
        ("Double-click Install ChainChat.command. macOS may require its normal confirmation for unsigned downloaded software. Setup never removes quarantine attributes or bypasses Gatekeeper.\n" if platform_name == 'darwin' else
         "Extract this archive, then run Install ChainChat.sh using your file manager's Run as Program action. If your desktop displays scripts as text, run it with sh. The installer does not need sudo.\n") +
        "Setup detects ARM64/x64, downloads exact hash-verified portable Node/Python, installs locked OpenClaw dependencies, and opens the local chat. No separate bridge startup or system runtime installation is needed. First setup needs Internet access and curl or wget.\n" +
        "Linux support is glibc distributions; musl/Alpine is not claimed. Files and data install only for your user. Existing external Timechains stay in place. Your API/model, wallet and chain remain explicit choices.\n" +
        "The source-built setup is unsigned. Read the release notes and SHA-256 sidecars. Runtime and dependency pins are in openclaw/upstream-lock.json; residual upstream risks are documented in openclaw/SECURITY.md.\n")
    directory.mkdir(parents=True, exist_ok=True)
    outputs = []
    if platform_name == 'darwin':
        filename = directory / (stem + '.zip')
        if filename.exists(): raise ValueError('Use a new installer output directory.')
        with zipfile.ZipFile(filename, 'x', compression=zipfile.ZIP_DEFLATED) as result:
            for name, data, mode in [('Install ChainChat.command', script, 0o755), ('README.txt', readme.encode(), 0o644)]:
                info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0)); info.create_system = 3
                info.external_attr = (0o100000 | mode) << 16
                result.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
        outputs.append(filename)
    else:
        filename = directory / (stem + '.tar.gz')
        if filename.exists() or (directory / (stem + '.run')).exists(): raise ValueError('Use a new installer output directory.')
        filename.write_bytes(gz_tar({'Install ChainChat.sh': (script, 0o755), 'README.txt': (readme.encode(), 0o644)}))
        outputs.append(filename)
        direct = directory / (stem + '.run'); direct.write_bytes(script); direct.chmod(0o755); outputs.append(direct)
    reports = []
    for output in outputs:
        report = {'version': package['version'], 'platform': system, 'architectures': ['arm64', 'x64'],
            'installer': output.name, 'bytes': output.stat().st_size,
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'payloadSha256': manifest['payloadSha256'],
            'openclawVersion': manifest['openclawVersion'], 'dependencyOverrides': manifest['dependencyOverrides'],
            'runtimes': runtimes, 'publisherSigned': False, 'requiresAdministrator': False,
            'networkNeededForFirstInstall': True}
        output.with_name(output.name + '.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        output.with_name(output.name + '.sha256').write_text(report['sha256'] + '  ' + output.name + '\n', encoding='ascii')
        reports.append(report)
    return reports


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--platform', choices=('darwin', 'linux', 'all'), default='all')
    args = parser.parse_args()
    reports = []
    for platform_name in (('darwin', 'linux') if args.platform == 'all' else (args.platform,)):
        reports.extend(build(args.archive, args.output_dir, platform_name))
    print(json.dumps(reports))
