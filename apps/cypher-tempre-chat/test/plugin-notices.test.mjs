import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePluginNotice } from '../lib/plugin-notices.mjs';
test('operator plugin consent notices preserve exact review tokens and bound native findings without unrelated fields', () => {
  const details = { capabilityConsentCode: 'PLUGIN_CAPABILITY_CONSENT_REQUIRED', pluginId: 'fixture', reviewToken: 'native-review-token',
    widened: { tools: ['fixture_tool'], hooks: ['message_sending'], extra: 'untrusted' }, secret: 'unrelated-private-field' };
  assert.deepEqual(nativePluginNotice(details), { kind: 'capabilities', pluginId: 'fixture', reviewToken: 'native-review-token', widened: { tools: ['fixture_tool'], hooks: ['message_sending'] } });
  const policy = nativePluginNotice({ installPolicyCode: 'install_policy_warning_acknowledgement_required', targetType: 'plugin',
    reason: 'Review code', findings: Array.from({ length: 100 }, () => ({ ruleId: 'native', severity: 'critical', message: 'x'.repeat(2000), evidence: 'private raw material' })) });
  assert.equal(policy.findings.length, 24); assert.equal(policy.findings[0].message.length, 1024);
  assert.equal(JSON.stringify(policy).includes('private raw material'), false);
  assert.equal(nativePluginNotice({ reviewToken: 'invented' }), null);
});
