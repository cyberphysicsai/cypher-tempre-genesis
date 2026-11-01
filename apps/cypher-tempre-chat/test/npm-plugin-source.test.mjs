import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createNpmPluginSourceResolver } from '../lib/npm-plugin-source.mjs';

function tar(entries) {
  const parts = [];
  for (const [name, value] of entries) {
    const content = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
function fixture(extra = []) {
  const archive = tar([['package/package.json', { name: '@fixture/plugin', version: '1.2.3', type: 'module' }],
    ['package/openclaw.plugin.json', { id: 'fixture-plugin', configSchema: { type: 'object' } }],
    ['package/index.mjs', 'globalThis.__fixturePluginExecuted = true;'], ...extra]);
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`, urls = [];
  const metadata = { 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': { dist: { integrity, tarball: 'https://registry.npmjs.org/@fixture/plugin/-/plugin-1.2.3.tgz' } } } };
  const resolver = createNpmPluginSourceResolver({ fetchImpl: async (url, options) => { urls.push({ url, options }); return new Response(url.includes('.tgz') ? archive : JSON.stringify(metadata)); } });
  return { archive, metadata, integrity, urls, resolver };
}

test('npm preview pins registry release, verifies archive SSRI and reads exact plugin identity without executing code', async () => {
  const f = fixture(), result = await f.resolver({ source: 'npm', spec: '@fixture/plugin@latest' });
  assert.equal(result.pluginId, 'fixture-plugin'); assert.equal(result.version, '1.2.3'); assert.equal(result.integrity, f.integrity);
  assert.equal(result.source.spec, '@fixture/plugin@1.2.3'); assert.equal(result.source.expectedPluginId, 'fixture-plugin');
  assert.equal(globalThis.__fixturePluginExecuted, undefined); assert.equal(f.urls.length, 2); assert.ok(f.urls.every(request => request.options.redirect === 'error'));
});

test('npm resolution rejects digest drift, ambiguous manifests, unsafe paths and non-registry artifact redirection', async () => {
  const drift = fixture(); drift.metadata.versions['1.2.3'].dist.integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
  await assert.rejects(drift.resolver({ source: 'npm', spec: '@fixture/plugin' }), /did not match/);
  const duplicate = fixture([['package/openclaw.plugin.json', { id: 'cypher-tempre-poi' }]]);
  await assert.rejects(duplicate.resolver({ source: 'npm', spec: '@fixture/plugin' }), /Ambiguous/);
  const unsafe = fixture([['package/../outside', 'unsafe']]);
  await assert.rejects(unsafe.resolver({ source: 'npm', spec: '@fixture/plugin' }), /Unsafe/);
  const alternate = fixture(); alternate.metadata.versions['1.2.3'].dist.tarball = 'http://127.0.0.1/private';
  await assert.rejects(alternate.resolver({ source: 'npm', spec: '@fixture/plugin' }), /native source resolver/);
  const mismatch = fixture(); await assert.rejects(mismatch.resolver({ source: 'npm', spec: '@fixture/plugin', expectedPluginId: 'different' }), /identity pin/);
});
