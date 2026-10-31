import importlib.util
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'installer'))
import posix_install as installer
import build_posix


class PortableInstallerGuards(unittest.TestCase):
    def source_fixture(self, filename, mutate=None):
        pins = json.loads((ROOT / 'openclaw/upstream-lock.json').read_text(encoding='utf-8'))
        if mutate: mutate(pins)
        runtime = {'dependencies': {'openclaw': pins['openclaw']['version']}, 'overrides': pins['dependencyOverrides']}
        locked = {'packages': {'node_modules/openclaw': {'version': pins['openclaw']['version'],
            'integrity': pins['openclaw']['integrity'], 'resolved': pins['openclaw']['source']},
            **{'node_modules/' + name: {'version': version} for name, version in pins['dependencyOverrides'].items()}}}
        files = {'package.json': json.dumps({'name': 'cypher-tempre-chat', 'version': '0.8.0'}).encode(),
            'server.mjs': b'// reviewed fixture\n', 'engine_bridge.py': b'# fixture\n', 'openclaw/launcher.mjs': b'// fixture\n',
            'openclaw/upstream-lock.json': json.dumps(pins).encode(), 'openclaw/runtime/package.json': json.dumps(runtime).encode(),
            'openclaw/runtime/package-lock.json': json.dumps(locked).encode(), 'installer/windows-installer.cs': b'// fixture\n',
            'installer/windows.manifest': b'<fixture/>', 'public/fonts/orbitron/Orbitron-Variable.ttf': b'fixture',
            'installer/posix_install.py': b'# only the reviewed archive copy\n',
            'installer/posix_bootstrap.sh': (ROOT / 'installer/posix_bootstrap.sh').read_bytes().replace(
                b'# Generated setup', b'# REVIEWED_ARCHIVE_MARKER\n# Generated setup')}
        with zipfile.ZipFile(filename, 'w') as archive:
            for name, content in files.items(): archive.writestr('app/' + name, content)

    def test_built_installers_preserve_reviewed_payload_and_executable_modes(self):
        with tempfile.TemporaryDirectory(prefix='ct-portable-build-') as temporary:
            base = Path(temporary); source = base / 'source.zip'; self.source_fixture(source)
            mac = build_posix.build(source, base / 'built', 'darwin')[0]
            linux = build_posix.build(source, base / 'built', 'linux')
            with zipfile.ZipFile(base / 'built' / mac['installer']) as archive:
                entry = archive.getinfo('Install ChainChat.command')
                self.assertEqual(entry.external_attr >> 16 & 0o777, 0o755)
                self.assertIn(b'REVIEWED_ARCHIVE_MARKER', archive.read(entry))
            direct = base / 'built' / linux[1]['installer']
            encoded = direct.read_bytes().split(b'\n__CHAINCHAT_PAYLOAD__\n', 1)[1]
            with tarfile.open(fileobj=io.BytesIO(base64.b64decode(encoded)), mode='r:gz') as archive:
                manifest = json.load(archive.extractfile('manifest.json'))
                self.assertEqual(archive.extractfile('payload.zip').read(), source.read_bytes())
                self.assertEqual(manifest['payloadSha256'], hashlib.sha256(source.read_bytes()).hexdigest())
                self.assertEqual(set(manifest['runtimes']), {'linux-x64', 'linux-arm64'})
            self.assertEqual(json.loads(direct.with_name(direct.name + '.json').read_text())['sha256'], hashlib.sha256(direct.read_bytes()).hexdigest())
            with self.assertRaises(ValueError): build_posix.build(source, base / 'built', 'linux')

    def test_builder_rejects_unreviewed_runtime_sources(self):
        with tempfile.TemporaryDirectory(prefix='ct-portable-bad-pin-') as temporary:
            base = Path(temporary); source = base / 'source.zip'
            self.source_fixture(source, lambda pins: pins['posix']['linux-x64']['python'].update(url='https://untrusted.example/python.tar.gz'))
            with self.assertRaises(ValueError): build_posix.build(source, base / 'built', 'linux')

    def test_source_rejects_traversal_symlinks_and_case_collisions(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-guards-') as temporary:
            base = Path(temporary)
            for number, entries in enumerate((
                [('app/../escape', b'x', 0o100644)],
                [('app/link', b'../escape', 0o120777)],
                [('app/A', b'x', 0o100644), ('app/a', b'y', 0o100644)],
                [('app/.env', b'private', 0o100644)],
            )):
                packed = base / (str(number) + '.zip')
                with zipfile.ZipFile(packed, 'w') as archive:
                    for name, content, mode in entries:
                        info = zipfile.ZipInfo(name); info.external_attr = mode << 16
                        archive.writestr(info, content)
                output = base / ('out-' + str(number)); output.mkdir()
                with self.assertRaises(ValueError): installer.extract_source(packed, output, 'app/')
            self.assertFalse((base / 'escape').exists())

    def test_runtime_rejects_external_links_and_special_files(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-runtime-') as temporary:
            base = Path(temporary)
            for number, (kind, target) in enumerate(((tarfile.SYMTYPE, '../../escape'), (tarfile.CHRTYPE, ''))):
                packed = base / (str(number) + '.tar.gz')
                with tarfile.open(packed, 'w:gz') as archive:
                    info = tarfile.TarInfo('runtime/link'); info.type, info.linkname = kind, target
                    archive.addfile(info)
                with self.assertRaises(ValueError): installer.extract_runtime(packed, base / ('out-' + str(number)))

    def test_source_integrity_detects_a_modified_immutable_release(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-integrity-') as temporary:
            base = Path(temporary); packed = base / 'source.zip'
            with zipfile.ZipFile(packed, 'w') as archive:
                info = zipfile.ZipInfo('app/server.mjs'); info.external_attr = 0o100755 << 16
                archive.writestr(info, b'export const version = 1;\n')
            output = base / 'app'; output.mkdir()
            expected = installer.extract_source(packed, output, 'app/')
            installer.verify_source(output, expected)
            (output / 'server.mjs').write_bytes(b'changed')
            with self.assertRaises(ValueError): installer.verify_source(output, expected)

    def test_pointer_paths_cannot_select_executables_outside_install_root(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-pointer-') as temporary:
            root = Path(temporary)
            with self.assertRaises(ValueError):
                installer.check_active(root, {'product': 'cypher-tempre-chainchat', 'version': '0.8.0',
                    'release': str(root), 'data': str(root), 'node': '/bin/sh', 'python': '/bin/sh'})

    def test_bootstrap_declares_pins_and_never_runs_an_unverified_download(self):
        source = (ROOT / 'installer/posix_bootstrap.sh').read_text(encoding='utf-8')
        self.assertIn('hash_file "$temp_dir/python.tar.gz"', source)
        self.assertLess(source.index('Python integrity check failed'), source.index('tar -xzf "$python_archive"'))
        self.assertLess(source.index('Bundled application integrity check failed'), source.index('"$temp_dir/python/bin/python3" -I'))
        self.assertNotIn('curl |', source)
        self.assertNotIn('sudo ', source)

    def test_exact_runtime_pins_cover_both_architectures(self):
        pins = json.loads((ROOT / 'openclaw/upstream-lock.json').read_text(encoding='utf-8'))['posix']
        self.assertEqual(set(pins), {'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'})
        for pair in pins.values():
            for name in ('node', 'python'):
                self.assertRegex(pair[name]['sha256'], r'^[a-f0-9]{64}$')
                self.assertTrue(pair[name]['url'].startswith('https://'))
        self.assertEqual({pair['node']['version'] for pair in pins.values()}, {'26.13.0'})

    @unittest.skipUnless(os.name == 'posix', 'POSIX permission ownership guard')
    def test_existing_public_writable_installation_root_is_refused(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-permissions-') as temporary:
            # macOS exposes its temporary root through the /var system alias.
            # Test permissions on a canonical path; alias rejection is separate.
            directory = Path(temporary).resolve() / 'shared'; directory.mkdir(); directory.chmod(0o777)
            with self.assertRaises(ValueError): installer.checked_root(directory)
            directory.chmod(0o700)
            self.assertEqual(installer.checked_root(directory), directory.resolve())

    @unittest.skipUnless(os.name == 'posix', 'POSIX symbolic-link ownership guard')
    def test_symlinked_installation_root_is_refused(self):
        with tempfile.TemporaryDirectory(prefix='ct-posix-alias-') as temporary:
            base = Path(temporary).resolve()
            actual = base / 'actual'; actual.mkdir(mode=0o700)
            marker = actual / 'preserved'; marker.write_text('preserved', encoding='utf-8')
            alias = base / 'alias'; alias.symlink_to(actual, target_is_directory=True)
            with self.assertRaises(ValueError): installer.checked_root(alias)
            self.assertEqual(marker.read_text(encoding='utf-8'), 'preserved')


if __name__ == '__main__': unittest.main()
