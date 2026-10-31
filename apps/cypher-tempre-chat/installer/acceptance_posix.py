#!/usr/bin/env python3
"""Actual isolated macOS/Linux install, native chain, owner auth and rollback checks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from posix_install import atomic_json, extract_runtime


def digest(filename): return hashlib.sha256(Path(filename).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installer', type=Path, required=True)
    parser.add_argument('--work-root', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path)
    args = parser.parse_args()
    if os.name != 'posix': parser.error('Run portable acceptance on macOS or Linux.')
    work = args.work_root.absolute()
    if work.exists() and any(work.iterdir()): parser.error('Choose an empty isolated acceptance directory.')
    work.mkdir(parents=True, exist_ok=True)
    target = work / 'installation'
    artifact = args.installer.resolve()
    setup = artifact
    if artifact.name.endswith('.tar.gz'):
        wrapper = work / 'setup'; extract_runtime(artifact, wrapper)
        setup = wrapper / 'Install ChainChat.sh'
    elif artifact.suffix == '.zip':
        wrapper = work / 'setup'; wrapper.mkdir()
        with zipfile.ZipFile(artifact) as archive:
            if set(archive.namelist()) != {'Install ChainChat.command', 'README.txt'}:
                raise RuntimeError('Unexpected macOS installer wrapper entries.')
            for entry in archive.infolist():
                if ((entry.external_attr >> 16) & 0o170000) == 0o120000: raise RuntimeError('Installer wrapper symlink denied.')
                (wrapper / entry.filename).write_bytes(archive.read(entry))
        setup = wrapper / 'Install ChainChat.command'
    flags = ['sh', str(setup), '--quiet', '--install-root', str(target), '--no-launch']
    if args.cache_dir: flags.extend(['--cache-dir', str(args.cache_dir.absolute())])
    home = work / 'synthetic-home'; home.mkdir(mode=0o700)
    xdg = home / '.local/share'
    env = {**os.environ, 'HOME': str(home), 'XDG_DATA_HOME': str(xdg), 'XDG_CACHE_HOME': str(home / '.cache'),
        'CT_CHAT_NO_BROWSER': '1', 'CT_CHAT_PORT': '0'}

    def install(label, expected=0):
        result_file = work / (label + '.json')
        with open(work / (label + '.log'), 'wb') as stream:
            result = subprocess.run(flags + ['--result-file', str(result_file)], env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=5400)
        if result.returncode != expected: raise RuntimeError(label + ' failed; see its isolated log.')
        data = json.loads(result_file.read_text(encoding='utf-8'))
        if data.get('ok') is not (expected == 0): raise RuntimeError(label + ' returned an inconsistent result.')
        return data

    install('first-install')
    active = json.loads((target / 'current.json').read_text(encoding='utf-8'))
    if sys.platform == 'darwin':
        app = home / 'Applications/Cypher Tempre ChainChat.app/Contents'
        with open(app / 'Info.plist', 'rb') as stream: metadata = plistlib.load(stream)
        shortcut = app / 'MacOS/ChainChat'
        if metadata.get('CFBundleIdentifier') != 'ai.cyphertempre.chainchat':
            raise RuntimeError('The isolated macOS application shortcut is invalid.')
    else:
        shortcut = xdg / 'applications/cypher-tempre-chainchat.desktop'
        if 'X-CypherTempre-Managed=true' not in shortcut.read_text(encoding='utf-8'):
            raise RuntimeError('The isolated Linux application shortcut is invalid.')
    if not os.access(shortcut, os.X_OK) or str(target / 'launcher.py') not in shortcut.read_text(encoding='utf-8'):
        raise RuntimeError('The application shortcut does not execute the installed front door.')
    release, data = Path(active['release']), Path(active['data'])
    if not release.resolve().is_relative_to(target.resolve()) or not data.resolve().is_relative_to(target.resolve()):
        raise RuntimeError('Installed paths escaped the test root.')
    environment = {**env, 'CT_OPERATOR_TRUST_ROOT': str(data / 'operator-approvals'), 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    native = data / 'agents/acceptance-agent'

    def engine(op, **fields):
        result = subprocess.run([active['python'], str(release / 'engine_bridge.py')], input=json.dumps({'op': op, 'root': str(native), **fields}),
            cwd=release, env=environment, capture_output=True, text=True, encoding='utf-8', timeout=180)
        value = json.loads(result.stdout)
        if result.returncode or not value.get('ok'): raise RuntimeError('Installed native engine fixture failed.')
        return value

    engine('init', name='Portable Installer Acceptance')
    if not engine('verify').get('verified'): raise RuntimeError('Installed native chain did not verify.')
    chain = native / 'chain/rings.jsonl'; chain_digest = digest(chain)
    sentinel = data / 'preserved-user-data.json'; sentinel.write_text('{"fixture":"preserve"}\n', encoding='utf-8')
    sentinel_digest = digest(sentinel)
    install('repeat-install')
    if digest(chain) != chain_digest or digest(sentinel) != sentinel_digest: raise RuntimeError('Repeat setup changed existing data.')
    policy = "import { requiresHoldings } from './public/chainchat-display.js'; if(['/api/launch','/api/local-resume','/api/audit/read'].some(p=>requiresHoldings(p,{})) || !requiresHoldings('/api/chat',{})) process.exit(1);"
    subprocess.run([active['node'], '--input-type=module', '-e', policy], cwd=release, check=True, env=environment, timeout=30)

    def frontdoor(label, expected=0, custom=None):
        filename = work / (label + '.json')
        result = subprocess.run([active['python'], str(target / 'launcher.py'), '--launch', '--quiet', '--install-root', str(target), '--result-file', str(filename)],
            env=custom or environment, capture_output=True, timeout=240)
        value = json.loads(filename.read_text(encoding='utf-8'))
        if result.returncode != expected or value.get('ok') is not (expected == 0): raise RuntimeError(label + ' readiness result failed.')
        return value

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def http(url, body=None, token=None, origin=None, expected=200):
        headers = {'content-type': 'application/json'}
        if token: headers['authorization'] = 'Bearer ' + token
        if origin: headers['origin'] = origin
        request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with opener.open(request, timeout=180) as response: status, value = response.status, json.load(response)
        except urllib.error.HTTPError as error: status, value = error.code, json.load(error)
        if status != expected: raise RuntimeError('A private installed HTTP assertion failed: ' + str(status))
        return value

    frontdoor('launch')
    owner = json.loads((data / 'runtime-owner.json').read_text())
    private = 'http://127.0.0.1:' + str(owner['port'])
    link = http(private + '/launch', {}, owner['token'])['url']
    parsed = urllib.parse.urlsplit(link); base = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))
    nonce = urllib.parse.parse_qs(parsed.fragment)['launch'][0]
    session = http(base + '/api/launch', {'nonce': nonce}, origin=base)
    token, ticket = session['token'], session['resumeTicket']
    state = http(base + '/api/state', token=token, origin=base)
    if state['executionRuntime']['backend'] != 'openclaw': raise RuntimeError('Installed app did not use OpenClaw.')
    http(base + '/api/agents/pair', {'root': str(native)}, token, base, 200)
    controls = http(base + '/api/openclaw', token=token, origin=base)
    if controls.get('runtime', {}).get('running') is not True or not controls.get('schema', {}).get('schema'):
        raise RuntimeError('The installed native OpenClaw control gateway did not become ready.')
    summary = http(base + '/api/audit/read', {'op': 'summary'}, token, base)
    if summary.get('verification', {}).get('ok') is not True: raise RuntimeError('Read-only installed audit did not verify.')
    http(base + '/api/local-resume', {'resumeTicket': ticket}, origin='https://cyphertempre.ai', expected=403)
    http(base + '/api/local-resume', {'resumeTicket': ticket}, expected=403)
    resumed = http(base + '/api/local-resume', {'resumeTicket': ticket}, origin=base)
    if resumed['token'] != token or resumed['resumeTicket'] == ticket: raise RuntimeError('Refresh did not preserve/rotate the owner session.')
    http(base + '/api/local-resume', {'resumeTicket': ticket}, origin=base, expected=403)
    frontdoor('relaunch')
    if json.loads((data / 'runtime-owner.json').read_text())['pid'] != owner['pid']: raise RuntimeError('Relaunch replaced the live owned runtime.')
    subprocess.run([active['node'], str(release / 'openclaw/launcher.mjs'), '--stop'], cwd=release, env={**environment, 'CT_CHAT_DATA': str(data)}, check=True, timeout=90)
    if (data / 'runtime-owner.json').exists(): raise RuntimeError('Owned runtime did not stop.')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); listener.listen(2)
        frontdoor('occupied-port', 1, {**environment, 'CT_CHAT_PORT': str(listener.getsockname()[1])})
        with socket.create_connection(listener.getsockname(), timeout=2): pass
    original = (release / 'server.mjs').read_bytes(); pointer = (target / 'current.json').read_bytes()
    try:
        (release / 'server.mjs').write_bytes(original + b'\n// isolated altered candidate\n')
        install('tampered-candidate', 1)
        if (target / 'current.json').read_bytes() != pointer: raise RuntimeError('Tampered setup changed active pointer.')
    finally: (release / 'server.mjs').write_bytes(original)
    atomic_json(target / 'previous.json', active)
    subprocess.run([active['python'], str(target / 'launcher.py'), '--rollback', '--quiet', '--no-launch', '--install-root', str(target)], env=environment, check=True, capture_output=True, timeout=180)
    if digest(chain) != chain_digest or digest(sentinel) != sentinel_digest: raise RuntimeError('Acceptance changed persistent user data.')
    result = {'installerSha256': digest(artifact), 'version': active['version'], 'platform': active['platform'],
        'freshInstall': True, 'repeatInstall': True, 'nativeVerified': True, 'dataPreserved': True,
        'ownedReady': True, 'openclawGatewayReady': True, 'samePidRelaunch': True, 'occupiedPortHeld': True, 'frontendBootstrapPolicy': True,
        'automaticOwnerAuth': True, 'rotatingResume': True, 'readOnlyAudit': True, 'tamperedCandidateHeld': True,
        'rollbackPointerPath': True, 'ownedRuntimeStopped': True, 'shortcutsCreated': True, 'shortcutsInSyntheticHome': True,
        'paidModelCalls': 0, 'productionUserInstallationTouched': False}
    atomic_json(work / 'acceptance-report.json', result)
    print(json.dumps(result))


if __name__ == '__main__': main()
