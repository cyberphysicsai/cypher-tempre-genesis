import test from 'node:test';
import assert from 'node:assert/strict';
import { managedServicesFactory } from '../openclaw/plugin/services.mjs';

test('native managed-service tool uses actual host-bound call identity and approved result', async () => {
  const calls = [], params = { action: 'create_job', name: 'Daily reading', prompt: 'Read my approved notes.', schedule: { kind: 'every', everyMs: 86400000 } };
  const factory = managedServicesFactory(async (...args) => { calls.push(args); return { allowed: true, result: { id: 'actual-native-job', enabled: true } }; });
  assert.equal(factory.contextVersion, 2);
  const tool = factory.create({ sessionKey: 'own-native-session', assertInvocationCurrent() {} });
  const result = await tool.execute('actual-native-call', params);
  assert.equal(calls[0][0], 'managed_service_execute');
  assert.deepEqual(calls[0][1], { sessionKey: 'own-native-session', runId: 'actual-native-call' });
  assert.deepEqual(calls[0][2], { params }); assert.equal(result.details.id, 'actual-native-job');
});
test('managed-service tool cannot run without current native invocation authority or approval', async () => {
  assert.throws(() => managedServicesFactory(async () => ({})).create({ sessionKey: 'own' }));
  const tool = managedServicesFactory(async () => ({ allowed: false })).create({ sessionKey: 'own', assertInvocationCurrent() {} });
  await assert.rejects(tool.execute('call', { action: 'list' }));
  const stale = managedServicesFactory(async () => { throw new Error('must never dispatch'); }).create({ sessionKey: 'own', assertInvocationCurrent() { throw new Error('stale'); } });
  await assert.rejects(stale.execute('call', { action: 'list' }), /stale/);
});
