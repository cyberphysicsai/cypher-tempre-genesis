import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverBrowserExecutable, BROWSER_INSTALL_GUIDANCE } from '../lib/browser-discovery.mjs';

test('Windows browser discovery uses fixed absolute executable suffixes and case-insensitive environment roots', async () => {
  const seen = [];
  const result = await discoverBrowserExecutable({ platform: 'win32', env: { programfiles: 'D:\\Apps', 'ProgramFiles(x86)': 'D:\\Apps32', LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local', PATH: 'Z:\\untrusted' },
    exists: async filename => { seen.push(filename); return filename === 'D:\\Apps32\\Microsoft\\Edge\\Application\\msedge.exe'; } });
  assert.equal(result, 'D:\\Apps32\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(seen.some(filename => filename.includes('untrusted') || filename.includes('User Data') || filename.endsWith('powershell.exe')), false);
});

test('browser discovery ignores relative and remote Windows roots instead of executing a search command', async () => {
  const seen = [];
  assert.equal(await discoverBrowserExecutable({ platform: 'win32', env: { ProgramFiles: '..\\override', LOCALAPPDATA: '\\\\server\\share' }, exists: async filename => { seen.push(filename); return false; } }), null);
  assert.equal(seen.every(filename => /^[A-Za-z]:\\/.test(filename)), true);
  assert.equal(seen.some(filename => filename.includes('server') || filename.includes('override')), false);
});

test('macOS discovers the bundle executable and never inspects personal profiles', async () => {
  const wanted = '/Users/fixture/Applications/Chromium.app/Contents/MacOS/Chromium', seen = [];
  assert.equal(await discoverBrowserExecutable({ platform: 'darwin', env: { HOME: '/Users/fixture' }, exists: async filename => { seen.push(filename); return filename === wanted; } }), wanted);
  assert.equal(seen.some(filename => filename.includes('Application Support')), false);
});

test('Linux discovery is a bounded fixed executable list, with no PATH or shell interpretation', async () => {
  const seen = [];
  assert.equal(await discoverBrowserExecutable({ platform: 'linux', env: { PATH: '/tmp/unsafe', BROWSER: 'sh -c bad' }, exists: async filename => { seen.push(filename); return filename === '/usr/bin/chromium'; } }), '/usr/bin/chromium');
  assert.equal(seen.includes('/tmp/unsafe'), false); assert.ok(seen.length < 15);
  assert.equal(await discoverBrowserExecutable({ platform: 'unknown', exists: async () => { throw new Error('Must not inspect unsupported platform'); } }), null);
  assert.match(BROWSER_INSTALL_GUIDANCE, /Set up managed Chromium/); assert.match(BROWSER_INSTALL_GUIDANCE, /separate owned browser profile/);
});
