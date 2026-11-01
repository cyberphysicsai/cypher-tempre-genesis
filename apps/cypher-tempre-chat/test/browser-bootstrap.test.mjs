import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBrowserBootstrap } from '../lib/browser-bootstrap.mjs';
import { resolveBrowserRuntime, discoverManagedBrowserExecutable } from '../lib/browser-discovery.mjs';

// Reviewed against playwright-core 1.63.0 lib/coreBundle.js EXECUTABLE_PATHS.chromium,
// supplied by the exact npm integrity in openclaw/runtime/package-lock.json.
const PINNED_CHROMIUM_PATHS = {
  'linux-x64': ['chrome-linux64', 'chrome'],
  'linux-arm64': ['chrome-linux-arm64', 'chrome'],
  'darwin-x64': ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  'darwin-arm64': ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  'win32-x64': ['chrome-win64', 'chrome.exe'],
};

async function fixture(t, script = null) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-browser-bootstrap-')));
  const packageRoot = path.join(root, 'node_modules', 'openclaw'), core = path.join(root, 'node_modules', 'playwright-core'), cacheDirectory = path.join(root, 'cache');
  const lock = JSON.parse(await fs.readFile(new URL('../openclaw/runtime/package-lock.json', import.meta.url), 'utf8'));
  await fs.mkdir(packageRoot, { recursive: true }); await fs.mkdir(core, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'openclaw', version: lock.packages['node_modules/openclaw'].version }));
  await fs.writeFile(path.join(core, 'package.json'), JSON.stringify({ name: 'playwright-core', version: lock.packages['node_modules/playwright-core'].version }));
  await fs.writeFile(path.join(core, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium', revision: '1243' }] }));
  const suffix = { 'win32-x64': ['chrome-win64', 'chrome.exe'], 'linux-x64': ['chrome-linux64', 'chrome'], 'linux-arm64': ['chrome-linux-arm64', 'chrome'],
    'darwin-x64': ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    'darwin-arm64': ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'] }[process.platform + '-' + process.arch];
  const executable = suffix && path.join(cacheDirectory, 'chromium-1243', ...suffix);
  await fs.writeFile(path.join(core, 'cli.js'), script || `const fs=require('node:fs'),path=require('node:path');
    const cache=process.env.PLAYWRIGHT_BROWSERS_PATH;
    fs.appendFileSync(path.join(cache,'calls.txt'),'one\\n');
    fs.writeFileSync(path.join(cache,'observed.json'),JSON.stringify({args:process.argv.slice(2),cache,
      provider:process.env.OPENAI_API_KEY,nodeOptions:process.env.NODE_OPTIONS,alternateDownload:process.env.PLAYWRIGHT_DOWNLOAD_HOST}));
    const executable=path.join(cache,'chromium-1243',...${JSON.stringify(suffix || [])});
    fs.mkdirSync(path.dirname(executable),{recursive:true});fs.writeFileSync(executable,'disposable test browser binary fixture');fs.chmodSync(executable,0o700);
    fs.writeFileSync(path.join(cache,'chromium-1243','INSTALLATION_COMPLETE'),'');`);
  const bootstrap = createBrowserBootstrap({ cacheDirectory, packageRoot, nodePath: process.execPath,
    environment: { ...process.env, OPENAI_API_KEY: 'never-to-child-fixture-key', NODE_OPTIONS: '--not-a-real-option', PLAYWRIGHT_DOWNLOAD_HOST: 'https://untrusted.invalid' } });
  t.after(async () => { await bootstrap.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, packageRoot, core, cacheDirectory, executable, bootstrap };
}

test('optional setup runs the locked CLI with fixed arguments and no provider or Node injection environment', async t => {
  const f = await fixture(t); assert.equal((await f.bootstrap.status()).state, 'not-installed');
  const result = await Promise.all([f.bootstrap.install(), f.bootstrap.install()]);
  assert.ok(result.every(item => item.state === 'installed')); assert.equal((await f.bootstrap.status()).state, 'installed');
  const observed = JSON.parse(await fs.readFile(path.join(f.cacheDirectory, 'observed.json'), 'utf8'));
  assert.deepEqual(observed.args, ['install', 'chromium']); assert.equal(observed.cache, await fs.realpath(f.cacheDirectory));
  for (const key of ['provider', 'nodeOptions', 'alternateDownload']) assert.equal(observed[key], undefined);
  assert.equal(await fs.readFile(path.join(f.cacheDirectory, 'calls.txt'), 'utf8'), 'one\n');
  await f.bootstrap.install(); assert.equal(await fs.readFile(path.join(f.cacheDirectory, 'calls.txt'), 'utf8'), 'one\n');
  assert.equal(await discoverManagedBrowserExecutable(f), f.executable);
  await fs.unlink(path.join(f.cacheDirectory, 'chromium-1243', 'INSTALLATION_COMPLETE'));
  assert.equal(await discoverManagedBrowserExecutable(f), null, 'An interrupted extraction is not an installed browser.');
  await f.bootstrap.install(); assert.equal(await fs.readFile(path.join(f.cacheDirectory, 'calls.txt'), 'utf8'), 'one\none\n');
});

test('browser setup refuses mismatched runtime libraries and preserves a useful failure status', async t => {
  const f = await fixture(t, 'process.exit(1)');
  await assert.rejects(f.bootstrap.install(), error => error.code === 'BROWSER_BOOTSTRAP_FAILED');
  assert.equal((await f.bootstrap.status()).state, 'failed');
  await fs.writeFile(path.join(f.core, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '0.0.0' }));
  await assert.rejects(resolveBrowserRuntime(f), /reviewed runtime lock/);
  await assert.rejects(f.bootstrap.install(), /reviewed runtime lock/);
});

test('cache discovery uses only exact locked revision and architecture artifacts', async t => {
  const f = await fixture(t), visited = [];
  assert.equal((await resolveBrowserRuntime(f)).version, '1.63.0', 'A Playwright pin update needs a fresh executable-path review.');
  for (const [platformKey, suffix] of Object.entries(PINNED_CHROMIUM_PATHS)) {
    const [platform, arch] = platformKey.split('-');
    const found = await discoverManagedBrowserExecutable({ ...f, platform, arch, exists: async file => { visited.push(file); return true; } });
    assert.equal(found, path.join(f.cacheDirectory, 'chromium-1243', ...suffix), platformKey + ' must match the reviewed upstream executable path.');
  }
  assert.equal(visited.length, 5);
  assert.equal(await discoverManagedBrowserExecutable({ ...f, platform: 'linux', arch: 'ia32', exists: async () => { throw new Error('Unsupported platform must not search.'); } }), null);
});

const nativePackage = process.env.CT_OPENCLAW_PACKAGE;
test('installed locked Playwright registry confirms every reviewed executable path', {
  skip: !nativePackage ? 'Set CT_OPENCLAW_PACKAGE to read the actual installed pinned browser registry.' : false,
}, async () => {
  const runtime = await resolveBrowserRuntime({ packageRoot: nativePackage });
  assert.equal(runtime.version, '1.63.0'); assert.equal(runtime.revision, '1243');
  const source = await fs.readFile(path.join(path.dirname(runtime.cliPath), 'lib', 'coreBundle.js'), 'utf8');
  const start = source.indexOf('EXECUTABLE_PATHS = {'), end = source.indexOf('"chromium-headless-shell":', start);
  assert.ok(start >= 0 && end > start, 'The reviewed native registry seam changed and needs review.');
  const chromium = source.slice(start, end);
  const entries = [...chromium.matchAll(/"(linux-x64|linux-arm64|mac-x64|mac-arm64|win-x64)":\s*(\[[^\r\n]*?\])/g)];
  assert.equal(entries.length, 5);
  for (const [, upstreamPlatform, json] of entries) {
    const platformKey = upstreamPlatform.replace(/^mac-/, 'darwin-').replace(/^win-/, 'win32-');
    assert.deepEqual(JSON.parse(json), PINNED_CHROMIUM_PATHS[platformKey], 'Pinned primary-source path changed: ' + upstreamPlatform);
  }
});

test('browser setup refuses symlinked caches and never spawns a downloader into them', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'other'); await fs.mkdir(outside);
  await fs.symlink(outside, f.cacheDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.bootstrap.install(), error => error.code === 'BROWSER_CACHE_UNSAFE');
  assert.deepEqual(await fs.readdir(outside), []);
});
