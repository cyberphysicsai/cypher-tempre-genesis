import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaFields, schemaFamilies, contextPolicyText, buildAutomationSchedule } from '../public/openclaw-settings.js';

test('memory-policy copy follows the reported native policy without inventing unlimited context or disabling required compaction', () => {
  const native = contextPolicyText({ mode: 'reviewed-native-compaction', automaticSummary: true, storedHistory: 'preserved', retainedRecentTurns: 2 });
  assert.match(native, /context pressure/); assert.match(native, /exact source/); assert.match(native, /through PoI/);
  assert.doesNotMatch(native, /compaction is off|unlimited/i);
  assert.match(contextPolicyText({ mode: 'timechain-retrieval', automaticSummary: false, storedHistory: 'preserved' }), /compaction is off/);
  for (const policy of [null, { mode: 'unknown' }, { mode: 'timechain-retrieval', automaticSummary: true, storedHistory: 'preserved' }]) {
    const message = contextPolicyText(policy); assert.match(message, /not reported a recognized/); assert.doesNotMatch(message, /compaction is off/);
  }
});

test('native schema search preserves exact editable field paths and bounds recursive schemas', () => {
  const schema = { schema: { properties: { agents: { type: 'object', properties: { defaults: { properties: {
    contextTokens: { type: 'integer', description: 'Safe context token budget' }, model: { type: 'string' },
  } } } }, gateway: { description: 'Managed authenticated transport', type: 'object' } } } };
  assert.deepEqual(schemaFields(schema, 'budget').map(x => x.name), ['agents.defaults.contextTokens']);
  assert.equal(schemaFields(schema, 'transport')[0].name, 'gateway');
  assert.equal(schemaFields(schema).some(x => x.name === 'agents.defaults.model'), true);
  const cyclic = { properties: {} }; cyclic.properties.again = cyclic;
  assert.ok(schemaFields(cyclic).length <= 16);
  assert.equal(schemaFields({ properties: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i), { type: 'boolean' }])) }).length, 500);
});

test('every native schema family remains discoverable with authoritative management reasons and scoped field search', () => {
  const schema = { properties: { agents: { properties: { defaults: { properties: { model: { type: 'string' }, contextTokens: { type: 'integer' } } } } },
    gateway: { title: 'Private transport', type: 'object' }, futureNativeFamily: { type: 'object' } } };
  const guards = { gateway: 'Private local operator transport.', 'agents.defaults.model': 'Choose models through the connection selector.' };
  const families = schemaFamilies(schema, guards, [{ key: 'agents', classification: 'editable', reason: 'Schema-validated defaults; managed children remain protected.' },
    { key: 'gateway', classification: 'supervisor-owned', reason: 'Cannot change private binding or authentication.' }]);
  assert.deepEqual(families.map(item => item.name), ['agents', 'futureNativeFamily', 'gateway']);
  assert.equal(families.find(item => item.name === 'futureNativeFamily').classification, 'reference');
  assert.equal(families.find(item => item.name === 'gateway').protected, true);
  assert.match(families.find(item => item.name === 'gateway').reason, /private binding/);
  assert.deepEqual(families.find(item => item.name === 'agents').guards.map(item => item.path), ['agents.defaults.model']);
  assert.deepEqual(schemaFields(schema, '', 'agents').map(item => item.name), ['agents', 'agents.defaults', 'agents.defaults.model', 'agents.defaults.contextTokens']);
  const large = { properties: { bulk: { properties: Object.fromEntries(Array.from({ length: 700 }, (_, i) => ['field' + i, { type: 'string' }])) }, lastFamily: { properties: { visible: { type: 'boolean' } } } } };
  assert.equal(schemaFields(large).length, 500);
  assert.deepEqual(schemaFields(large, '', 'lastFamily').map(item => item.name), ['lastFamily', 'lastFamily.visible']);
});

test('service forms create bounded native schedules without client-supplied execution fields', () => {
  assert.deepEqual(buildAutomationSchedule({ kind: 'every', minutes: '30' }), { kind: 'every', everyMs: 1800000 });
  assert.deepEqual(buildAutomationSchedule({ kind: 'at', at: '2026-11-02T09:00:00Z' }, Date.parse('2026-11-01T09:00:00Z')),
    { kind: 'at', at: '2026-11-02T09:00:00.000Z' });
  assert.deepEqual(buildAutomationSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }), { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' });
  for (const minutes of ['', '0', '0.5', '525601']) assert.throws(() => buildAutomationSchedule({ kind: 'every', minutes }));
  assert.throws(() => buildAutomationSchedule({ kind: 'cron', expr: '* * * * * *', tz: 'UTC' }));
  assert.throws(() => buildAutomationSchedule({ kind: 'at', at: 'not-a-date' }));
});
