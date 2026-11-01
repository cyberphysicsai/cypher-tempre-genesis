import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaFields, buildAutomationSchedule } from '../public/openclaw-settings.js';

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

test('service forms create bounded native schedules without client-supplied execution fields', () => {
  assert.deepEqual(buildAutomationSchedule({ kind: 'every', minutes: '30' }), { kind: 'every', everyMs: 1800000 });
  assert.deepEqual(buildAutomationSchedule({ kind: 'at', at: '2026-11-02T09:00:00Z' }, Date.parse('2026-11-01T09:00:00Z')),
    { kind: 'at', at: '2026-11-02T09:00:00.000Z' });
  assert.deepEqual(buildAutomationSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }), { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' });
  for (const minutes of ['', '0', '0.5', '525601']) assert.throws(() => buildAutomationSchedule({ kind: 'every', minutes }));
  assert.throws(() => buildAutomationSchedule({ kind: 'cron', expr: '* * * * * *', tz: 'UTC' }));
  assert.throws(() => buildAutomationSchedule({ kind: 'at', at: 'not-a-date' }));
});
