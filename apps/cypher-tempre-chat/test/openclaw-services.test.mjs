import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAutomationRpc, createPrivateNativeServices } from '../lib/openclaw-services.mjs';

const nodePath = 'owned-node', id = '00000000-0000-4000-8000-000000000001';
const signal = () => ({ name: `ChainChat ${id}`, declarationKey: `chainchat-managed:${id}`, enabled: false, deleteAfterRun: false,
  agentId: 'main', sessionTarget: 'isolated', wakeMode: 'next-heartbeat', schedule: { kind: 'every', everyMs: 60000, anchorMs: 1 },
  payload: { kind: 'command', argv: [nodePath, '--input-type=module', '-e', 'process.stdout.write("NO_REPLY")'],
    timeoutSeconds: 15, noOutputTimeoutSeconds: 10, outputMaxBytes: 64, toolsAllow: [] }, delivery: { mode: 'none' } });

test('automation transport admits fixed no-model signals and rejects command/model/delivery substitution', () => {
  assert.deepEqual(validateAutomationRpc('cron.add', signal(), nodePath), signal());
  for (const mutate of [job => { job.enabled = true; }, job => { job.payload.argv[3] = 'console.log(process.env)'; },
    job => { job.payload = { kind: 'agentTurn', message: 'Run without admission' }; }, job => { job.delivery.mode = 'announce'; },
    job => { job.payload.toolsAllow = ['exec']; }, job => { job.schedule.everyMs = 1; }]) {
    const job = signal(); mutate(job); assert.throws(() => validateAutomationRpc('cron.add', job, nodePath));
  }
  assert.throws(() => validateAutomationRpc('config.patch', {}, nodePath));
  assert.throws(() => validateAutomationRpc('cron.update', { id, patch: { enabled: true, payload: signal().payload } }, nodePath));
  assert.deepEqual(validateAutomationRpc('cron.update', { id, patch: { enabled: false } }, nodePath), { id, patch: { enabled: false } });
});

test('registered private service requires per-method validation and filters native events', async () => {
  let dispatch; const calls = [], events = [];
  const services = createPrivateNativeServices({ nodePath, rpc: async (...args) => { calls.push(args); return { ok: true }; },
    subscribe: listener => { dispatch = listener; return () => { dispatch = null; }; } });
  const channel = services.registerNativeService({ id: 'managed-channel', methods: { send: params => {
    if (params.target !== 'owned-target') throw new Error('denied'); return { target: params.target, text: params.text };
  } }, events: ['channel.message'] });
  channel.subscribe(event => events.push(event));
  await assert.rejects(channel.request('config.patch', {}));
  await assert.rejects(channel.request('send', { target: 'other-target' })); assert.equal(calls.length, 0);
  await channel.request('send', { target: 'owned-target', text: 'reviewed' }); assert.equal(calls.length, 1);
  dispatch({ event: 'auth.private' }); dispatch({ event: 'channel.message' }); assert.equal(events.length, 1);
  const plugins = services.registerNativeService({ id: 'slow-native-plugin-install', requestTimeoutMs: 240000, methods: { 'plugins.list': () => ({}) } });
  await plugins.request('plugins.list', {}); assert.deepEqual(calls.at(-1), ['plugins.list', {}, { timeoutMs: 240000 }]);
  assert.throws(() => services.registerNativeService({ id: 'unbounded-timeout', requestTimeoutMs: Infinity, methods: { 'plugins.list': () => ({}) } }));
  services.close(); assert.equal(dispatch, null); await assert.rejects(channel.request('send', { target: 'owned-target' }));
});
