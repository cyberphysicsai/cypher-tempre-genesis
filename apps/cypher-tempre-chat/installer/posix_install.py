#!/usr/bin/env python3
"""Per-user macOS/glibc-Linux setup and authenticated installed front door."""
from __future__ import annotations
import argparse
import contextlib
try:
    import fcntl
except ImportError:  # Archive/build checks can run on Windows; installation cannot.
    fcntl = None
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
import zipfile

MAX_ARCHIVE = 1024**3
PRIVATE = {'.git', '.local', 'node_modules', '__pycache__', 'chain', 'tasks'}


def sha256(filename):
    digest = hashlib.sha256()
    with open(filename, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(filename, value):
    filename = Path(filename)
    temporary = filename.with_name(filename.name + '.' + uuid.uuid4().hex + '.tmp')
    with open(temporary, 'x', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, sort_keys=True)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, filename)


def atomic_file(filename, content, mode=0o600):
    temporary = filename.with_name(filename.name + '.' + uuid.uuid4().hex + '.tmp')
    with open(temporary, 'xb') as stream:
        os.chmod(temporary, mode); stream.write(content); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, filename)


def runtime_key():
    system = {'Darwin': 'darwin', 'Linux': 'linux'}.get(platform.system())
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(platform.machine().lower())
    if not system or not arch:
        raise ValueError('This setup supports macOS and glibc Linux on ARM64/x64.')
    if system == 'linux' and platform.libc_ver()[0].lower() == 'musl':
        raise ValueError('The reviewed Linux runtime requires glibc, not musl.')
    return system + '-' + arch


def checked_root(value):
    raw = Path(value).expanduser().absolute()
    if raw == Path(raw.anchor) or any(ord(char) < 32 for char in str(raw)):
        raise ValueError('Choose a dedicated per-user installation directory.')
    if raw.is_symlink() or (raw.exists() and not raw.is_dir()):
        raise ValueError('The installation root must be an ordinary directory.')
    if raw.exists() and os.name == 'posix':
        info = raw.stat()
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError('Choose a private installation directory owned by your user.')
    raw.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = raw.resolve()
    if root != raw:
        raise ValueError('Symlinked installation roots are not supported.')
    os.chmod(root, 0o700)
    return root


def beneath(root, filename):
    resolved = Path(filename).resolve()
    if not resolved.is_relative_to(root.resolve()) or resolved == root.resolve():
        raise ValueError('An installed path escaped its root.')
    return resolved


def archive_parts(name):
    parts = PurePosixPath(name).parts
    if not parts or name.startswith('/') or '\\' in name or '\0' in name or '..' in parts or ':' in name:
        raise ValueError('An archive contains an unsafe path.')
    return parts


def extract_runtime(archive, directory):
    """Extract only hash-verified runtime tarballs, with internal links bounded."""
    directory.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, 'r:gz') as packed:
        entries = packed.getmembers()
        if len(entries) > 200000 or sum(entry.size for entry in entries) > 4 * MAX_ARCHIVE:
            raise ValueError('Runtime archive exceeds its reviewed extraction bounds.')
        seen = set()
        for entry in entries:
            parts = archive_parts(entry.name)
            identity = '/'.join(parts).casefold()
            if identity in seen:
                raise ValueError('Runtime archive has duplicate paths.')
            seen.add(identity)
            if not (entry.isdir() or entry.isfile() or entry.issym() or entry.islnk()):
                raise ValueError('Runtime archive contains a special file.')
            if entry.issym() or entry.islnk():
                if entry.linkname.startswith('/') or '\\' in entry.linkname or '\0' in entry.linkname:
                    raise ValueError('Runtime archive has an external link.')
                base = directory if entry.islnk() else directory.joinpath(*parts).parent
                target = (base / entry.linkname).resolve()
                if not target.is_relative_to(directory.resolve()):
                    raise ValueError('Runtime archive link escaped its root.')
        packed.extractall(directory, filter='data')


def extract_source(archive, directory, prefix):
    expected = {}
    with zipfile.ZipFile(archive) as packed:
        entries = packed.infolist()
        if len(entries) > 100000 or sum(item.file_size for item in entries) > 4 * MAX_ARCHIVE:
            raise ValueError('Application archive exceeds its extraction limit.')
        seen = set()
        for entry in entries:
            archive_parts(entry.orig_filename)
            if not entry.orig_filename.startswith(prefix):
                raise ValueError('Application path is outside the reviewed prefix.')
            relative = entry.orig_filename[len(prefix):].rstrip('/')
            if not relative:
                continue
            parts = archive_parts(relative)
            if any(part in PRIVATE or part.startswith('.env') for part in parts):
                raise ValueError('Application archive includes private runtime data.')
            if relative.casefold() in seen:
                raise ValueError('Application archive has duplicate paths.')
            seen.add(relative.casefold())
            mode = entry.external_attr >> 16
            if mode & 0o170000 == 0o120000:
                raise ValueError('Application source cannot contain symlinks.')
            destination = directory.joinpath(*parts)
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            content = packed.read(entry)
            with open(destination, 'xb') as stream:
                stream.write(content)
            os.chmod(destination, 0o755 if mode & 0o111 else 0o644)
            expected[relative] = hashlib.sha256(content).hexdigest()
    if not expected:
        raise ValueError('Application source is empty.')
    return expected


def verify_source(directory, expected):
    for name, digest in expected.items():
        filename = beneath(directory, directory / name)
        if filename.is_symlink() or not filename.is_file() or sha256(filename) != digest:
            raise ValueError('An immutable application release was modified; it was not activated.')


def fetch_archive(pin, cache):
    parsed = urllib.parse.urlsplit(pin['url'])
    if parsed.scheme != 'https' or parsed.hostname not in {'nodejs.org', 'github.com'}:
        raise ValueError('Unexpected runtime download host.')
    filename = cache / Path(urllib.parse.unquote(parsed.path)).name
    if filename.is_file() and sha256(filename) == pin['sha256']:
        return filename
    temporary = cache / (filename.name + '.' + uuid.uuid4().hex + '.tmp')
    request = urllib.request.Request(pin['url'], headers={'User-Agent': 'Cypher-Tempre-Setup'})
    class HttpsRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, message, headers, newurl):
            if urllib.parse.urlsplit(newurl).scheme != 'https':
                raise ValueError('Runtime download redirected outside HTTPS.')
            return super().redirect_request(request, fp, code, message, headers, newurl)
    with urllib.request.build_opener(HttpsRedirect()).open(request, timeout=90) as response, open(temporary, 'xb') as stream:
        if not response.url.startswith('https://'):
            raise ValueError('Runtime download redirected outside HTTPS.')
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ARCHIVE:
                raise ValueError('Runtime download exceeded its limit.')
            stream.write(chunk)
    if sha256(temporary) != pin['sha256']:
        raise ValueError('A runtime archive failed SHA-256 verification.')
    os.replace(temporary, filename)
    return filename


def environment(active):
    allowed = {key: value for key, value in os.environ.items()
        if not re.search(r'KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL', key, re.I)
        and not re.match(r'OPENCLAW_|CHAINCHAT_|CT_|OTEL_|SENTRY_', key, re.I)
        and (not key.lower().startswith('npm_config_') or key in {'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_CACHE'})
        and key not in {'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME'}}
    allowed.update(CT_CHAT_DATA=active['data'], CT_CHAT_PYTHON=active['python'],
        CT_OPENCLAW_MODULE=str(Path(active['release']) / 'openclaw/runtime/node_modules/openclaw'),
        CT_OPERATOR_TRUST_ROOT=str(Path(active['data']) / 'operator-approvals'),
        PYTHONIOENCODING='utf-8', PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1',
        PATH=str(Path(active['node']).parent) + os.pathsep + allowed.get('PATH', ''))
    for name in ('CT_CHAT_PORT', 'CT_CHAT_NO_BROWSER'):
        if name in os.environ:
            allowed[name] = os.environ[name]
    return allowed


def run_checked(command, active, log, timeout=3600):
    with open(log, 'ab') as stream:
        result = subprocess.run([str(part) for part in command], cwd=active['release'],
            env=environment(active), stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise RuntimeError('A reviewed installation check failed. See ' + str(log))


def check_active(root, active):
    if active.get('product') != 'cypher-tempre-chainchat' or not isinstance(active.get('version'), str):
        raise ValueError('The active installation pointer is invalid.')
    for key in ('release', 'node', 'python', 'data'):
        beneath(root, active.get(key, ''))
    if not Path(active['release']).is_dir() or not Path(active['node']).is_file() or not Path(active['python']).is_file():
        raise ValueError('The selected application or runtime is unavailable.')
    return active


def authenticated_status(root, active):
    filename = root / 'data/runtime-owner.json'
    try:
        if filename.is_symlink(): return None
        owner = json.loads(filename.read_text(encoding='utf-8'))
        if not isinstance(owner.get('pid'), int) or not isinstance(owner.get('port'), int) or not 1 <= owner['port'] <= 65535:
            return None
        if not re.fullmatch(r'[a-f0-9]{64}', owner.get('token', '')) or owner.get('version') != active['version']:
            return None
        if Path(owner.get('appRoot', '')).resolve() != Path(active['release']).resolve():
            return None
        try: os.kill(owner['pid'], 0)
        except (ProcessLookupError, PermissionError): return None
        request = urllib.request.Request(f"http://127.0.0.1:{owner['port']}/status", headers={'Authorization': 'Bearer ' + owner['token']})
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs): return None
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=2) as response:
            status = json.load(response)
        return owner if status.get('pid') == owner['pid'] and status.get('version') == active['version'] else None
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def launch(root, quiet=False):
    active = check_active(root, json.loads((root / 'current.json').read_text(encoding='utf-8')))
    with open(root / '.launch.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        log = root / 'data/launch.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        with open(log, 'ab') as stream:
            os.chmod(log, 0o600)
            child = subprocess.Popen([active['node'], str(Path(active['release']) / 'openclaw/launcher.mjs')],
                cwd=active['release'], env=environment(active), stdout=stream, stderr=subprocess.STDOUT,
                start_new_session=True)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            owner = authenticated_status(root, active)
            exited = child.poll()
            if owner and (owner['pid'] == child.pid or exited == 0):
                return {'ok': True, 'ready': True, 'version': active['version'], 'reused': owner['pid'] != child.pid}
            if exited is not None:
                break
            time.sleep(.2)
    raise RuntimeError('ChainChat did not become ready. Close an older conflicting app and inspect ' + str(log))


def shortcuts(root, python):
    command = [str(python), str(root / 'launcher.py'), '--launch', '--install-root', str(root)]
    if sys.platform == 'darwin':
        bundle = Path.home() / 'Applications/Cypher Tempre ChainChat.app/Contents'
        if (bundle / 'Info.plist').exists():
            with open(bundle / 'Info.plist', 'rb') as stream:
                if plistlib.load(stream).get('CFBundleIdentifier') != 'ai.cyphertempre.chainchat':
                    raise ValueError('The Applications shortcut belongs to another application.')
        (bundle / 'MacOS').mkdir(parents=True, exist_ok=True)
        executable = bundle / 'MacOS/ChainChat'
        executable.write_text('#!/bin/sh\nexec ' + ' '.join(shlex.quote(part) for part in command) + '\n', encoding='utf-8')
        executable.chmod(0o755)
        with open(bundle / 'Info.plist', 'wb') as stream:
            plistlib.dump({'CFBundleName': 'Cypher Tempre ChainChat', 'CFBundleExecutable': 'ChainChat',
                'CFBundleIdentifier': 'ai.cyphertempre.chainchat', 'CFBundlePackageType': 'APPL',
                'CFBundleShortVersionString': json.loads((root / 'current.json').read_text(encoding='utf-8'))['version'], 'LSUIElement': True}, stream)
    else:
        directory = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'applications'
        directory.mkdir(parents=True, exist_ok=True)
        def quoted(value):
            return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%') + '"'
        desktop = directory / 'cypher-tempre-chainchat.desktop'
        if desktop.exists() and 'X-CypherTempre-Managed=true' not in desktop.read_text(encoding='utf-8'):
            raise ValueError('The application shortcut belongs to another application.')
        desktop.write_text('[Desktop Entry]\nType=Application\nName=Cypher Tempre ChainChat\nComment=Local OpenClaw and PoI Timechain chat\nExec=' +
            ' '.join(quoted(part) for part in command) + '\nTerminal=false\nCategories=Utility;Development;\nX-CypherTempre-Managed=true\n', encoding='utf-8')
        desktop.chmod(0o755)


def install(args):
    bundle = args.bundle.resolve()
    manifest = json.loads((bundle / 'manifest.json').read_text(encoding='utf-8'))
    key = runtime_key()
    if key not in manifest['runtimes'] or key.split('-')[0] != manifest['platform']:
        raise ValueError('This reviewed installer does not support the current platform.')
    root = checked_root(args.install_root)
    data, releases, runtimes = root / 'data', root / 'releases', root / 'runtimes'
    for directory in (data, releases, runtimes):
        if directory.is_symlink(): raise ValueError('Installation data/runtime directories cannot be symlinked.')
        directory.mkdir(exist_ok=True, mode=0o700)
        beneath(root, directory)
    cache = Path(args.cache_dir).expanduser().absolute()
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(root / '.install.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        payload = bundle / 'payload.zip'
        if sha256(payload) != manifest['payloadSha256']:
            raise ValueError('Bundled application integrity verification failed.')
        pins = manifest['runtimes'][key]
        python_home = runtimes / ('python-' + pins['python']['version'] + '-' + key + '-' + pins['python']['sha256'][:12])
        beneath(root, python_home)
        if not python_home.exists():
            temporary = runtimes / ('.python-' + uuid.uuid4().hex)
            shutil.copytree(args.bootstrap_python.resolve(), temporary, symlinks=True)
            os.replace(temporary, python_home)
        node_home = runtimes / ('node-' + pins['node']['version'] + '-' + key + '-' + pins['node']['sha256'][:12])
        beneath(root, node_home)
        if not node_home.exists():
            archive = fetch_archive(pins['node'], cache)
            temporary = runtimes / ('.node-' + uuid.uuid4().hex)
            extract_runtime(archive, temporary)
            packaged = temporary / pins['node']['prefix'].rstrip('/')
            if not packaged.is_dir(): raise ValueError('The Node archive prefix is invalid.')
            os.replace(packaged, node_home)
            temporary.rmdir()
        release = releases / (manifest['version'] + '-' + manifest['payloadSha256'][:12])
        stage = releases / ('.stage-' + uuid.uuid4().hex)
        stage.mkdir()
        expected = extract_source(payload, stage, manifest['payloadPrefix'])
        if release.exists():
            verify_source(release, expected)
            shutil.rmtree(stage)
        else:
            active_stage = {'product': 'cypher-tempre-chainchat', 'version': manifest['version'],
                'release': str(stage), 'node': str(node_home / 'bin/node'), 'python': str(python_home / 'bin/python3'), 'data': str(data)}
            npm = node_home / 'lib/node_modules/npm/bin/npm-cli.js'
            # Ignore inherited npm configuration/credentials and all lifecycle scripts.
            empty = stage / '.npm-empty-config'; empty.write_text('', encoding='utf-8')
            global_empty = stage / '.npm-global-empty-config'; global_empty.write_text('', encoding='utf-8')
            environment_before = {name: os.environ.get(name) for name in ('NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_CACHE')}
            os.environ.update(NPM_CONFIG_USERCONFIG=str(empty), NPM_CONFIG_GLOBALCONFIG=str(global_empty),
                NPM_CONFIG_REGISTRY='https://registry.npmjs.org', NPM_CONFIG_CACHE=str(cache / 'npm'))
            try:
                for prefix in (stage, stage / 'openclaw/runtime'):
                    run_checked([active_stage['node'], npm, 'ci', '--ignore-scripts', '--prefix', prefix], active_stage, root / 'install.log')
                run_checked([active_stage['node'], stage / 'openclaw/launcher.mjs', '--check'], active_stage, root / 'install.log', 120)
            finally:
                for name, value in environment_before.items():
                    if value is None: os.environ.pop(name, None)
                    else: os.environ[name] = value
                empty.unlink(missing_ok=True)
                global_empty.unlink(missing_ok=True)
            atomic_json(stage / '.chainchat-files.json', expected)
            os.replace(stage, release)
        active = {'product': 'cypher-tempre-chainchat', 'version': manifest['version'], 'platform': key,
            'release': str(release), 'node': str(node_home / 'bin/node'), 'python': str(python_home / 'bin/python3'),
            'data': str(data), 'payloadSha256': manifest['payloadSha256']}
        run_checked([active['node'], release / 'openclaw/launcher.mjs', '--check'], active, root / 'install.log', 120)
        current_file = root / 'current.json'
        if current_file.exists():
            previous = check_active(root, json.loads(current_file.read_text(encoding='utf-8')))
            if not args.no_launch:
                run_checked([previous['node'], Path(previous['release']) / 'openclaw/launcher.mjs', '--stop'], previous, root / 'install.log', 60)
            if previous['release'] != active['release']: atomic_json(root / 'previous.json', previous)
        # The installed front door is reviewed source from this exact payload.
        atomic_file(root / 'launcher.py', (release / 'installer/posix_install.py').read_bytes(), 0o700)
        atomic_json(current_file, active)
        if not args.no_shortcuts: shortcuts(root, python_home / 'bin/python3')
    if not args.no_launch: launch(root, args.quiet)
    return {'ok': True, 'version': manifest['version'], 'platform': key, 'root': str(root),
        'release': str(release), 'data': str(data), 'sourceVerified': True, 'runtimeVerified': True,
        'ready': not args.no_launch, 'shortcutsCreated': not args.no_shortcuts}


def rollback(root, quiet=False, no_launch=False):
    selected = check_active(root, json.loads((root / 'previous.json').read_text(encoding='utf-8')))
    current = check_active(root, json.loads((root / 'current.json').read_text(encoding='utf-8')))
    run_checked([selected['node'], Path(selected['release']) / 'openclaw/launcher.mjs', '--check'], selected, root / 'install.log', 120)
    run_checked([current['node'], Path(current['release']) / 'openclaw/launcher.mjs', '--stop'], current, root / 'install.log', 60)
    atomic_json(root / 'current.json', selected); atomic_json(root / 'previous.json', current)
    if not no_launch: launch(root, quiet)
    return {'ok': True, 'version': selected['version'], 'rollback': True, 'dataPreserved': True}


def default_root():
    return Path.home() / 'Library/Application Support/CypherTempre/ChainChat' if sys.platform == 'darwin' else Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'CypherTempre/ChainChat'


def show_launch_error(root):
    message = 'ChainChat did not become ready. Close an older conflicting app, then reopen ChainChat. Diagnostics: ' + str(root / 'data/launch.log')
    try:
        if sys.platform == 'darwin':
            script = 'on run argv\ndisplay alert "Cypher Tempre ChainChat" message (item 1 of argv) as critical\nend run'
            subprocess.Popen(['/usr/bin/osascript', '-e', script, message], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        elif os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'):
            if shutil.which('zenity'):
                subprocess.Popen(['zenity', '--error', '--title=Cypher Tempre ChainChat', '--text=' + message], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            elif shutil.which('kdialog'):
                subprocess.Popen(['kdialog', '--error', message, '--title', 'Cypher Tempre ChainChat'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--bootstrap-python', type=Path)
    parser.add_argument('--install-root', type=Path, default=default_root())
    parser.add_argument('--cache-dir', type=Path, default=Path.home() / '.cache/CypherTempre/downloads')
    parser.add_argument('--no-launch', action='store_true')
    parser.add_argument('--no-shortcuts', action='store_true')
    parser.add_argument('--quiet', action='store_true')
    parser.add_argument('--launch', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--result-file', type=Path)
    args = parser.parse_args()
    if os.name != 'posix': parser.error('This setup runs on macOS or glibc Linux.')
    try:
        if args.launch: result = launch(checked_root(args.install_root), args.quiet)
        elif args.rollback: result = rollback(checked_root(args.install_root), args.quiet, args.no_launch)
        else:
            if not args.bundle or not args.bootstrap_python: parser.error('A verified setup bundle and bootstrap runtime are required.')
            result = install(args)
        if args.result_file: atomic_json(args.result_file, result)
        print(json.dumps(result))
    except Exception as error:
        with contextlib.suppress(Exception):
            log = args.install_root.expanduser().absolute() / 'install.log'
            with open(log, 'a', encoding='utf-8') as stream:
                os.chmod(log, 0o600)
                stream.write(type(error).__name__ + ': ' + str(error) + '\n')
        result = {'ok': False, 'error': 'ChainChat setup or startup failed. Inspect install.log and data/launch.log in the selected installation.'}
        if args.result_file:
            with contextlib.suppress(Exception): atomic_json(args.result_file, result)
        print(json.dumps(result), file=sys.stderr)
        if not args.quiet:
            print('Setup did not complete. Existing chains and the previously selected release are retained.', file=sys.stderr)
            if args.launch: show_launch_error(args.install_root.expanduser().absolute())
        raise SystemExit(1)


if __name__ == '__main__':
    main()
