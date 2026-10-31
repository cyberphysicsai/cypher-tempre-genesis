import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaFields } from '../public/openclaw-settings.js';

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
