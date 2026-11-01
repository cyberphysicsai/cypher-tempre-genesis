import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createGuardedContextFactory } from '../openclaw/plugin/context-guard.mjs';
import { createReviewedContextEngine } from '../openclaw/plugin/compaction.mjs';

function core(overrides = {}) {
  const original = createReviewedContextEngine({ sdk: { SessionManager: { openAsync() {} }, buildSessionContext() {} },
    request: async () => {}, commitStore: { registerIfAbsent() {}, lookup() {} } });
  return { ...original, bootstrap: async () => ({ bootstrapped: true }), ingest: async () => ({ ingested: true }),
    assemble: async () => ({ messages: [{ role: 'user', content: 'Fixture' }], systemPromptAddition: 'approved-context' }),
    compact: async () => ({ ok: false, compacted: false, reason: 'Ordinary policy hold.' }),
    commitTurn: async () => ({ status: 'committed' }), ...overrides };
}
const context = { workspaceDir: path.join(os.tmpdir(), 'owned-native-workspace') };

test('health constructs the real selected engine once and accepts only an empty private request', async () => {
  let loads = 0; const selected = core(), stopped = [];
  const guarded = createGuardedContextFactory({ context, load: async received => {
    assert.deepEqual(received, context); loads++; return selected;
  }, onCriticalFault: reason => stopped.push(reason) });
  const health = await guarded.probe({}), facade = await guarded.factory();
  assert.deepEqual(health, { version: 1, pluginId: 'cypher-tempre-poi', engineId: 'cypher-tempre-poi', healthy: true });
  assert.deepEqual(facade.info, selected.info); assert.equal(loads, 1);
  assert.deepEqual(await facade.bootstrap({}), { bootstrapped: true });
  assert.equal((await facade.compact({})).compacted, false);
  assert.equal((await guarded.probe({})).healthy, true, 'An ordinary policy hold is not an engine fault.');
  await assert.rejects(guarded.probe({ sessionKey: 'untrusted' })); assert.equal(stopped.length, 0);
});

test('factory import, shape and workspace failures return a valid held engine without throwing into native fallback', async () => {
  for (const options of [{ load: async () => { throw new Error('private-loader-details'); } },
    { load: async () => ({ ...core(), compact: null }) },
    { context: { workspaceDir: 'relative' }, load: async () => core() }]) {
    const guarded = createGuardedContextFactory({ context, ...options, onCriticalFault: () => {} });
    const facade = await guarded.factory(), health = await guarded.probe({});
    assert.equal(health.healthy, false); assert.equal(health.reasonCode, 'FACTORY_FAILED');
    assert.equal(facade.info.ownsCompaction, true);
    assert.deepEqual(await facade.ingest({}), { ingested: false });
    assert.equal((await facade.bootstrap({})).bootstrapped, false);
    assert.deepEqual(await facade.assemble({ messages: [{ role: 'user', content: 'private-history' }] }),
      { messages: [], estimatedTokens: 0, systemPromptAddition: '', promptAuthority: 'assembled' });
    assert.equal((await facade.compact({})).compacted, false);
    assert.equal(JSON.stringify({ health, facade }).includes('private-loader-details'), false);
  }
});

test('unexpected bootstrap, assembly, ingestion and compaction failures latch across all subsequent native factories', async () => {
  for (const name of ['bootstrap', 'assemble', 'ingest', 'compact']) {
    let compactCalls = 0;
    const selected = core({ compact: async () => { compactCalls++; return { ok: false, compacted: false }; },
      [name]: async () => { throw new Error('unexpected-private-details'); } });
    const guarded = createGuardedContextFactory({ context, load: async () => selected, onCriticalFault: () => {} });
    const facade = await guarded.factory(); await facade[name]({});
    assert.equal((await guarded.probe({})).healthy, false);
    const again = await guarded.factory();
    assert.equal((await again.compact({})).compacted, false); assert.equal(compactCalls, 0);
    assert.equal((await again.assemble({})).systemPromptAddition, '');
  }
});

test('commit failures and invalid acknowledgments invoke fail-stop before rejection and never invent a commit', async () => {
  for (const commitTurn of [async () => { throw new Error('private-invariant-details'); }, async () => ({ status: 'unknown' })]) {
    const order = [], guarded = createGuardedContextFactory({ context, load: async () => core({ commitTurn }),
      onCriticalFault: reason => order.push(reason) });
    const facade = await guarded.factory();
    await assert.rejects(facade.commitTurn({}), error => { assert.deepEqual(order, ['COMMIT_TURN_FAILED']); return error.code === 'OPENCLAW_ENFORCEMENT_UNHEALTHY'; });
    assert.equal((await guarded.probe({})).healthy, false);
  }
});

test('a concurrent lifecycle fault revokes pending context but does not deny an already completed reviewed write', async () => {
  for (const name of ['assemble', 'compact']) {
    let finish, entered;
    const started = new Promise(resolve => { entered = resolve; }), pending = new Promise(resolve => { finish = resolve; });
    const result = name === 'assemble' ? { messages: [], systemPromptAddition: 'previously-authorized-context' } :
      { ok: true, compacted: true, result: { details: { reviewed: true } } };
    const selected = core({ [name]: async () => { entered(); await pending; return result; },
      ingest: async () => { throw new Error('Concurrent synthetic fault'); } });
    const guarded = createGuardedContextFactory({ context, load: async () => selected, onCriticalFault: () => {} });
    const facade = await guarded.factory(), operation = facade[name]({}); await started;
    await facade.ingest({}); finish();
    const actual = await operation;
    if (name === 'assemble') assert.deepEqual(actual, { messages: [], estimatedTokens: 0, systemPromptAddition: '', promptAuthority: 'assembled' });
    else assert.deepEqual(actual, result);
    assert.equal((await guarded.probe({})).healthy, false);
  }
});

test('production-style owned-process exit happens before native can catch a commit error and select fallback', () => {
  const script = `import {createGuardedContextFactory} from ${JSON.stringify(new URL('../openclaw/plugin/context-guard.mjs', import.meta.url).href)};
    const engine=${JSON.stringify(core().info)};
    const guarded=createGuardedContextFactory({context:${JSON.stringify(context)},load:async()=>({info:engine,
      bootstrap:async()=>({bootstrapped:true}),ingest:async()=>({ingested:false}),assemble:async()=>({messages:[]}),compact:async()=>({ok:false,compacted:false}),
      commitTurn:async()=>{throw new Error('synthetic failure')}}),onCriticalFault:()=>process.exit(78)});
    try{await(await guarded.factory()).commitTurn({})}catch{console.log('UNSAFE_NATIVE_FALLBACK')}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000,
    windowsHide: true, env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {} });
  assert.equal(result.status, 78, result.stderr); assert.equal(result.stdout, '');
});
