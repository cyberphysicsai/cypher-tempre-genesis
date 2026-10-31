import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { engine } from '../lib/engine.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const good = () => ({ approved: true, scores: Object.fromEntries(DIMENSIONS.map(k => [k, 240])),
  fruitages: Object.fromEntries(FRUITS.map(k => [k, 240])), usedRings: [], rationale: 'Supported and compatible with the covenant.' });
const candidate = "Hello! I'm Cypher Tempre, your conversational assistant. I can help you explore ideas and think through questions carefully.";
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-openclaw-broker-')), root = path.join(dir, 'agent');
  await engine({ op: 'init', root, name: 'Cypher Tempre' });
  let time = Date.now(); const seen = [];
  const broker = createPoIBroker({ engine, review: async (config, args) => { seen.push(args); return options.assessment?.() || good(); }, now: () => time });
  await broker.start();
  t.after(async () => { await broker.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dir, { recursive: true, force: true }); });
  const config = { provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'fixture-private-key' };
  const context = { root, input: 'Please introduce yourself', purpose: 'candidate', loadout: [], settings: { recall: false }, authorize: async () => {} };
  const register = extra => broker.registerInvocation({ config, args: { messages: [{ role: 'user', content: context.input }] },
    context: { ...context, ...extra }, sessionKey: 'agent:main:chainchat:fixture', invocationId: 'fixture' });
  const call = async (op, fields = {}, headers = {}) => {
    const response = await fetch(broker.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${broker.token}`, ...headers },
      body: JSON.stringify({ version: 1, op, sessionKey: 'agent:main:chainchat:fixture', runId: 'run-one', ...fields }) });
    return { status: response.status, body: await response.json() };
  };
  return { broker, root, seen, register, call, setTime: value => { time = value; } };
}
test('OpenClaw authority is private and unknown claims fail closed', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('admit', {}, { authorization: 'Bearer invalid' })).status, 403);
  assert.equal((await f.call('admit', {}, { origin: 'https://example.com' })).status, 403);
  assert.equal((await f.call('admit')).body.allowed, false);
});
test('native prepare/review/evaluate bind an exact candidate, but UI retains commit ownership', async t => {
  const f = await fixture(t), claim = await f.register();
  assert.equal((await f.call('admit')).body.allowed, true);
  const prepared = (await f.call('prepare')).body;
  assert.ok(prepared.context.includes('Proof of Interaction'));
  assert.ok(prepared.context.includes('CHAINCHAT HOST CONTRACT'));
  assert.deepEqual(prepared.toolsAllow, []);
  const final = (await f.call('finalize', { candidate, candidateSha256: hash(candidate) })).body;
  assert.equal(final.allowed, true); assert.equal(final.receipt.reviewed, true);
  assert.equal(f.seen[0].trustedAgentContext.name, 'Cypher Tempre');
  assert.equal((await f.broker.assertCandidate({ claimId: claim.claimId, candidate })).commitOwner, 'chainchat');
  await assert.rejects(f.broker.assertCandidate({ claimId: claim.claimId, candidate: candidate + ' changed' }));
  assert.equal((await f.call('outgoing', { candidate: candidate + ' changed' })).body.allowed, false);
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0, 'Individual model candidates cannot double-commit the user turn.');
  assert.equal((await f.call('tool', { tool: { name: 'exec', params: { command: 'echo ungranted' } } })).body.allowed, false);
});
test('low semantic/native scores and changed run identities cannot release output', async t => {
  const f = await fixture(t, { assessment: () => { const result = good(); result.fruitages.love = 179; return result; } });
  const claim = await f.register(); await f.call('admit');
  assert.equal((await f.call('prepare', { runId: 'another-run' })).body.allowed, false);
  assert.equal((await f.call('finalize', { candidate })).body.allowed, false);
  await assert.rejects(f.broker.assertCandidate({ claimId: claim.claimId, candidate }));
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0);
});
test('utility invocations cannot acquire tool rights or pretend to be an active plain call', async t => {
  const f = await fixture(t);
  await assert.rejects(f.register({ purpose: 'plain' }));
  const claim = await f.register({ purpose: 'utility' }); await f.call('admit');
  const prepared = (await f.call('prepare')).body; assert.equal(prepared.context, ''); assert.deepEqual(prepared.toolsAllow, []);
  assert.equal((await f.call('finalize', { candidate: '{"queries":[]}' })).body.purpose, 'utility');
  assert.equal(f.seen.length, 0, 'Review/planning calls cannot recursively trigger model review.');
  assert.equal((await f.call('tool', { tool: { name: 'read', params: {} } })).body.allowed, false);
  f.setTime(Date.now() + 600_000);
  await assert.rejects(f.broker.assertCandidate({ claimId: claim.claimId, candidate: '{"queries":[]}' }));
});
