import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedBrowserProfilesResult, sanitizeOwnedBrowserResult } from '../openclaw/plugin/browser-results.mjs';

test('profiles are projected only from actual owned authority facts without claiming personal inventory', () => {
  const native = { profile: 'chainchat-owned', isolated: true, running: true, closed: false, networkHosts: ['example.com'], network: [],
    cdpUrl: 'http://127.0.0.1:18000', userDataDir: '/home/fixture/private-browser/profile' };
  const result = ownedBrowserProfilesResult(native);
  assert.deepEqual(result.details, { scope: 'owned-profile-only', profiles: [{ name: 'chainchat-owned', isolated: true, running: true, closed: false }] });
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  assert.equal(Object.hasOwn(result.details, 'systemProfiles'), false);
  assert.equal(JSON.stringify(result).includes('private-browser'), false);
  for (const override of [{ profile: 'personal' }, { isolated: false }, { running: 'true' }, { closed: undefined }])
    assert.throws(() => ownedBrowserProfilesResult({ ...native, ...override }));
});

test('native status JSON removes private paths and debugger endpoints from both content and details', () => {
  const payload = { running: true, profile: 'chainchat-owned', driver: 'cdp', pid: 1234, cdpPort: 18000,
    cdpUrl: 'http://127.0.0.1:18000', userDataDir: 'C:\\Users\\fixture\\private-browser\\profile',
    detectedExecutablePath: 'C:\\Users\\fixture\\runtime\\chrome.exe',
    diagnostic: 'Profile C:\\Users\\fixture\\private-browser\\profile with http://127.0.0.1:18000 is running.' };
  const result = sanitizeOwnedBrowserResult({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload });
  const text = JSON.stringify(result);
  for (const secret of ['127.0.0.1', 'private-browser', 'chrome.exe', 'cdpPort', 'userDataDir', 'detectedExecutablePath']) assert.equal(text.includes(secret), false, secret);
  assert.equal(result.details.running, true); assert.equal(result.details.profile, 'chainchat-owned');
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  assert.equal(payload.cdpPort, 18000, 'The native receipt is never mutated.');
});

test('wrapped native tabs keep exact page identities while removing ws URLs from embedded JSON and images stay intact', () => {
  const payload = { running: true, tabs: [{ targetId: 'real-target-42', title: 'Research page', url: 'https://example.com/research?q=1',
    wsUrl: 'ws://127.0.0.1:18000/devtools/page/real-target-42' }] };
  const prefix = '<<<EXTERNAL_UNTRUSTED_CONTENT id="fixture">>>\nSource: Browser\n---\n', suffix = '\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="fixture">>>';
  const image = { type: 'image', mimeType: 'image/png', data: 'actual-inline-image-fixture-bytes' };
  const result = sanitizeOwnedBrowserResult({ content: [{ type: 'text', text: prefix + JSON.stringify(payload) + suffix }, image], details: payload });
  assert.ok(result.content[0].text.startsWith(prefix)); assert.ok(result.content[0].text.endsWith(suffix));
  assert.equal(JSON.stringify(result).includes('ws://'), false); assert.equal(JSON.stringify(result).includes('devtools/page'), false);
  assert.deepEqual(result.details.tabs[0], { targetId: 'real-target-42', title: 'Research page', url: 'https://example.com/research?q=1' });
  assert.deepEqual(result.content[1], image);
});

test('personal profile rows and nested system-profile inventory never enter the reduced copies', () => {
  const payload = { profiles: [{ name: 'personal-work', userDataDir: '/home/private/chrome' }, { name: 'chainchat-owned', running: true, cdpUrl: 'http://localhost:19000' }],
    systemProfiles: [{ name: 'Private person', path: '/home/private/Default' }], systemProfilesUnavailable: 'Private inventory diagnostic' };
  const result = sanitizeOwnedBrowserResult({ content: [{ type: 'text', text: JSON.stringify(payload) }], details: payload });
  assert.deepEqual(result.details, { profiles: [{ name: 'chainchat-owned', running: true }] });
  for (const secret of ['personal-work', 'Private person', '/home/private', 'systemProfiles', 'localhost']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('known private echoes and standalone loopback control URLs are removed without dropping public page observations', () => {
  const result = sanitizeOwnedBrowserResult({ content: [{ type: 'text', text: 'Control ws://[::1]:18000/devtools/browser/opaque and /private/profile/store. Page https://example.com stays available.' }],
    details: { targetId: 'unchanged', title: 'Actual title', url: 'https://example.com' } }, { privateValues: ['/private/profile/store'] });
  assert.equal(JSON.stringify(result).includes('18000'), false); assert.equal(JSON.stringify(result).includes('/private/profile/store'), false);
  assert.equal(result.details.url, 'https://example.com'); assert.equal(result.details.targetId, 'unchanged');
});

test('profile dictionaries and page-controlled special keys cannot expose other profiles or alter the reducer prototype', () => {
  const payload = JSON.parse('{"profiles":{"personal":{"userDataDir":"/private/Default"},"chainchat-owned":{"running":true,"cdpUrl":"http://localhost:19000"}},"__proto__":{"title":"page-data"}}');
  const result = sanitizeOwnedBrowserResult({ details: payload });
  assert.deepEqual(result.details.profiles, { 'chainchat-owned': { running: true } });
  assert.equal(Object.getPrototypeOf(result.details), Object.prototype);
  assert.equal(Object.hasOwn(result.details, '__proto__'), true); assert.equal({}.title, undefined);
});
