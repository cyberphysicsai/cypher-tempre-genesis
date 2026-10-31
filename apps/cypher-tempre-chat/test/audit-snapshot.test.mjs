import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { readChainAudit } from '../lib/audit-snapshot.mjs';
import { createAuditConnection, validateAuditRequest } from '../public/audit/chainchat-connection.js';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, count = 3) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-audit-read-'));
  const root = path.join(directory, 'agent');
  await fs.mkdir(path.join(root, 'chain/blockspace/blobs'), { recursive: true });
  await fs.mkdir(path.join(root, 'registry'));
  const rings = Array.from({ length: count }, (_, index) => ({ index, ring_type: index ? 'thought' : 'genesis',
    timestamp: '2026-10-31T00:00:00Z', ring_hash: sha(String(index)), prev_hash: index ? sha(String(index - 1)) : '0'.repeat(64),
    payload: { name: 'Cypher Tempre', summary: `Ring ${index}`, labels: { keywords: ['care'], entities: ['user'] } },
    poi: { brightness: 240 }, blockspace_refs: [] }));
  await fs.writeFile(path.join(root, 'chain/rings.jsonl'), rings.map(ring => JSON.stringify(ring)).join('\n') + '\n');
  await fs.writeFile(path.join(root, 'chain/blockspace/index.json'), '{}');
  await fs.writeFile(path.join(root, 'registry/modalities.json'), JSON.stringify({ modalities: [{ id: '1', category: 'reason' }] }));
  await fs.writeFile(path.join(root, 'registry/senses.json'), JSON.stringify({ senses: [{ id: '2', category: 'perceive' }] }));
  const inspect = () => ({ verified: true, height: count, head: { index: count - 1, hash: rings.at(-1).ring_hash }, verification: ['Native verification passed.'] });
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('ct-audit-read-')); await fs.rm(directory, { recursive: true, force: true, maxRetries: 8 }); });
  return { directory, root, rings, inspect };
}
async function inventory(root) {
  const result = {};
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file); else result[path.relative(root, file)] = sha(await fs.readFile(file));
    }
  }
  await walk(root); return result;
}

test('audit projects native registries and canonical ring data without writing or inventing verification', async t => {
  const f = await fixture(t), before = await inventory(f.root); let inspected = 0;
  assert.equal((await readChainAudit({ root: f.root, op: 'summary' })).verification.ok, null);
  const summary = await readChainAudit({ root: f.root, op: 'summary', inspect: () => { inspected++; return f.inspect(); } });
  assert.equal(summary.verification.ok, true); assert.equal(summary.stats.rings, 3);
  assert.equal(summary.stats.modalities, 1); assert.equal(summary.stats.senses, 1);
  assert.deepEqual(summary.modalityCategories, [{ name: 'reason', count: 1 }]);
  const listed = await readChainAudit({ root: f.root, op: 'rings' });
  assert.equal(listed.rings[0].index, 2); assert.equal(listed.rings[0].brightness, 240);
  assert.deepEqual(await readChainAudit({ root: f.root, op: 'ring', index: 1 }), f.rings[1]);
  assert.equal(inspected, 1); assert.deepEqual(await inventory(f.root), before);
});

test('audit pages bound records and reject mutation, arbitrary paths and malformed controls', async t => {
  const f = await fixture(t, 205);
  const first = await readChainAudit({ root: f.root, op: 'rings', limit: 100 });
  assert.equal(first.rings.length, 100); assert.equal(first.rings[0].index, 204); assert.equal(first.hasMore, true);
  const next = await readChainAudit({ root: f.root, op: 'rings', offset: 100, limit: 100 });
  assert.equal(next.rings[0].index, 104);
  for (const request of [{ op: 'seal' }, { op: 'rings', limit: 101 }, { op: 'rings', limit: 0 }, { op: 'rings', offset: -1 },
    { op: 'ring', index: true }, { op: 'blob', hash: '../secret' }, { op: 'summary', hash: 'a'.repeat(64) }, { op: 'summary', command: 'execute' }])
    await assert.rejects(readChainAudit({ root: f.root, ...request }), error => error.code === 'AUDIT_INVALID');
});

test('blob previews hash actual bytes, bound previews, distinguish binaries and never fake integrity', async t => {
  const f = await fixture(t), bytes = Buffer.from('care '.repeat(30000)), hash = sha(bytes);
  await fs.writeFile(path.join(f.root, 'chain/blockspace/blobs', hash), bytes);
  await fs.writeFile(path.join(f.root, 'chain/blockspace/index.json'), JSON.stringify({ [hash]: { filename: '<script>data</script>', size: bytes.length, mime: 'text/plain' } }));
  const list = await readChainAudit({ root: f.root, op: 'blockspace' });
  assert.equal(list.total, 1); assert.equal(list.entries[0].filename, '<script>data</script>');
  const preview = await readChainAudit({ root: f.root, op: 'blob', hash });
  assert.equal(preview.verified, true); assert.equal(preview.size, bytes.length); assert.equal(preview.truncated, true);
  assert.ok(Buffer.byteLength(preview.preview) <= 128 * 1024);
  const wrong = 'f'.repeat(64); await fs.writeFile(path.join(f.root, 'chain/blockspace/blobs', wrong), bytes);
  assert.equal((await readChainAudit({ root: f.root, op: 'blob', hash: wrong })).verified, false);
  const binary = Buffer.from([0, 1, 2, 0]), binaryHash = sha(binary);
  await fs.writeFile(path.join(f.root, 'chain/blockspace/blobs', binaryHash), binary);
  const output = await readChainAudit({ root: f.root, op: 'blob', hash: binaryHash });
  assert.equal(output.text, false); assert.equal(output.preview, '');
});

test('missing verification, corrupt records, head changes and oversized metadata are surfaced honestly', async t => {
  const f = await fixture(t);
  const failed = await readChainAudit({ root: f.root, op: 'summary', inspect: async () => { throw new Error('do-not-echo-private-error'); } });
  assert.equal(failed.verification.ok, false); assert.equal(JSON.stringify(failed).includes('do-not-echo-private-error'), false);
  const moved = await readChainAudit({ root: f.root, op: 'summary', inspect: { verified: true, head: { index: 3, hash: 'e'.repeat(64) } } });
  assert.equal(moved.verification.ok, null); assert.ok(moved.notices.some(value => value.includes('differ')));
  await fs.appendFile(path.join(f.root, 'chain/rings.jsonl'), '{broken\n');
  const corrupt = await readChainAudit({ root: f.root, op: 'summary', inspect: f.inspect });
  assert.equal(corrupt.verification.ok, false); assert.equal(corrupt.partial, true);
  await fs.writeFile(path.join(f.root, 'registry/modalities.json'), ' '.repeat(2 * 1024 * 1024 + 1));
  assert.ok((await readChainAudit({ root: f.root, op: 'summary' })).notices.some(value => value.includes('oversized')));
});

test('audit denies symlinked roots and hardlinked metadata outside the selected root', async t => {
  const f = await fixture(t), alias = path.join(f.directory, 'alias');
  await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readChainAudit({ root: alias, op: 'rings' }), error => error.code === 'AUDIT_PATH');
  const secret = path.join(f.directory, 'private-file'); await fs.writeFile(secret, '{}');
  const metadata = path.join(f.root, 'chain/blockspace/index.json'); await fs.unlink(metadata); await fs.link(secret, metadata);
  await assert.rejects(readChainAudit({ root: f.root, op: 'blockspace' }), error => error.code === 'AUDIT_PATH');
});

test('tail windows and blob verification obey hard byte limits and label incomplete history', async t => {
  const f = await fixture(t, 2);
  const huge = { ...f.rings[0], payload: { summary: 'x'.repeat(9 * 1024 * 1024) } };
  await fs.writeFile(path.join(f.root, 'chain/rings.jsonl'), JSON.stringify(huge) + '\n' + JSON.stringify(f.rings[1]) + '\n');
  const summary = await readChainAudit({ root: f.root, op: 'summary', inspect: f.inspect });
  assert.equal(summary.partial, true); assert.equal(summary.stats.rings, 2);
  assert.ok(summary.notices.some(value => value.includes('8 MiB')));
  const listed = await readChainAudit({ root: f.root, op: 'rings' }); assert.deepEqual(listed.rings.map(ring => ring.index), [1]);
  const hash = 'e'.repeat(64), file = path.join(f.root, 'chain/blockspace/blobs', hash);
  await fs.writeFile(file, ''); await fs.truncate(file, 16 * 1024 * 1024 + 1);
  await assert.rejects(readChainAudit({ root: f.root, op: 'blob', hash }), error => error.code === 'AUDIT_LIMIT' && error.status === 413);
});

function browser() {
  const listeners = new Set(), sent = [], parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  const view = { parent, location: { origin: 'http://127.0.0.1:8790' }, crypto: webcrypto,
    addEventListener: (_name, callback) => listeners.add(callback), removeEventListener: (_name, callback) => listeners.delete(callback) };
  return { view, parent, sent, emit: event => { for (const callback of listeners) callback(event); } };
}
test('auditor message channel binds exact parent and origin and forwards only fixed read requests', async () => {
  const b = browser(), connection = createAuditConnection({ window: b.view });
  for (const request of [{ op: 'seal' }, { op: 'summary', token: 'private' }, { op: 'blob', hash: '../../private' }, { op: 'rings', limit: 101 }])
    await assert.rejects(connection.read(request));
  assert.equal(b.sent.length, 0);
  const pending = connection.read({ op: 'summary' }); let resolved = false; pending.then(() => { resolved = true; });
  const { message, origin } = b.sent[0]; assert.equal(origin, b.view.location.origin);
  assert.deepEqual(Object.keys(message).sort(), ['id', 'request', 'type']);
  assert.equal(message.type, 'chainchat-audit:request');
  const response = { type: 'chainchat-audit:response', id: message.id, result: { verified: true } };
  b.emit({ source: b.parent, origin: 'https://attacker.example', data: response });
  b.emit({ source: {}, origin, data: response });
  b.emit({ source: b.parent, origin, data: { ...response, id: 'wrong-id' } });
  b.emit({ source: b.parent, origin, data: { ...response, error: 'ambiguous' } });
  await Promise.resolve(); assert.equal(resolved, false);
  b.emit({ source: b.parent, origin, data: response }); assert.deepEqual(await pending, { verified: true }); connection.close();
});

test('auditor message channel bounds outstanding reads, rejects close and validates narrow operation shapes', async () => {
  const b = browser(), connection = createAuditConnection({ window: b.view });
  for (const request of [{ op: 'summary', offset: 0 }, { op: 'ring' }, { op: 'ring', index: -1 }, { op: 'rings', index: 0 }]) assert.throws(() => validateAuditRequest(request));
  const all = Array.from({ length: 12 }, () => connection.read({ op: 'rings' })); const settled = Promise.allSettled(all);
  await assert.rejects(connection.read({ op: 'rings' }), /Too many/); connection.close();
  assert.equal((await settled).every(item => item.status === 'rejected'), true);
  await assert.rejects(connection.read({ op: 'summary' }), /closed/);
});
