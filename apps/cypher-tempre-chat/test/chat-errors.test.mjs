import test from 'node:test';
import assert from 'node:assert/strict';
import { chatFailure, providerLimits, loadoutRepairNotice } from '../public/chat-errors.js';

test('chat diagnostics never render raw transport bodies, credentials, URLs or unknown code/stage strings', () => {
  const privateValue = 'https://private.example.invalid/key=not-for-display';
  for (const error of [
    { code: 'GATE_INVALID_REVIEW', stage: 'review', message: privateValue, response: privateValue },
    { code: 'OPENCLAW_CONTROL_CLOSED', stage: privateValue, message: privateValue },
    { code: privateValue, stage: privateValue, message: privateValue },
  ]) assert.equal(JSON.stringify(chatFailure(error)).includes(privateValue), false);
  assert.equal(chatFailure({ code: privateValue }).code, 'REQUEST_FAILED');
  assert.equal(chatFailure({ code: 'GATE_INVALID_REVIEW', stage: 'review' }).stageLabel, 'Covenant review');
});

test('provider/review compatibility failures do not masquerade as semantic rejection or chain corruption', () => {
  for (const code of ['GATE_INVALID_REVIEW', 'GATE_INVALID_EVIDENCE', 'GATE_INVALID_CONTEXT']) {
    const view = chatFailure({ code });
    assert.equal(view.kind, 'review'); assert.equal(view.action, 'model');
    assert.notEqual(view.title, 'POI REVIEW HELD');
  }
  assert.equal(chatFailure({ code: 'PROVIDER_INCOMPLETE', stage: 'memory-planning' }).stageLabel, 'Memory planning');
  assert.equal(chatFailure({ code: 'OPENCLAW_CONTEXT_BUDGET' }).action, 'model');
  const gate = { approved: false, fruits: { kindness: 179 }, rationale: 'Held by the reviewer.' };
  const error = { code: 'COVENANT_REJECTED', gate }, before = structuredClone(error);
  assert.equal(chatFailure(error).kind, 'gate');
  assert.equal(chatFailure(error).action, null);
  assert.deepEqual(error, before, 'Diagnostics never change the gate assessment.');
});

test('protected native holds offer inspection/recheck, never an unlock or bypass action', () => {
  assert.equal(chatFailure({ code: 'PENDING_HELD' }).action, 'continuum');
  assert.equal(chatFailure({ code: 'PENDING_STALE' }).action, 'continuum');
  assert.equal(chatFailure({ code: 'CHAIN_LOCKED' }).action, 'inspect');
  assert.equal(chatFailure({ code: 'INVALID_LOADOUT' }).action, 'loadout');
  assert.equal(chatFailure({ name: 'AbortError' }).code, 'REQUEST_CANCELLED');
  assert.equal(chatFailure({ code: 'OPENCLAW_ENFORCEMENT_UNHEALTHY' }).action, 'native');
});

test('optional model limits preserve existing connections and reject invalid token ceilings', () => {
  assert.deepEqual(providerLimits({ contextWindow: '', maxOutputTokens: '' }), {});
  assert.deepEqual(providerLimits({ contextWindow: '32768', maxOutputTokens: '4096', apiKey: 'not-a-limit' }), { contextWindow: 32768, maxOutputTokens: 4096 });
  assert.deepEqual(providerLimits({ contextWindow: 2097152, maxOutputTokens: 32768 }), { contextWindow: 2097152, maxOutputTokens: 32768 });
  for (const input of [
    { contextWindow: '4095' }, { contextWindow: '2097153' }, { maxOutputTokens: '127' },
    { maxOutputTokens: '32769' }, { maxOutputTokens: '1e3' }, { maxOutputTokens: '0x1000' },
    { contextWindow: '4096', maxOutputTokens: '8192' }, { contextWindow: '4096', maxOutputTokens: '4096' }, { contextWindow: '8192.5' },
  ]) assert.throws(() => providerLimits(input), { code: 'INVALID_PROVIDER_LIMITS' });
});

test('catalogue reconciliation notice exposes only removed faculty IDs', () => {
  assert.equal(loadoutRepairNotice(null), '');
  assert.equal(loadoutRepairNotice({ reason: 'unavailable-faculties', removed: { modalities: [], senses: [] } }), '');
  const notice = loadoutRepairNotice({ reason: 'unavailable-faculties', removed: { modalities: ['37'], senses: ['10', '84'] } });
  assert.match(notice, /modalities: 37/); assert.match(notice, /senses: 10, 84/);
  assert.match(notice, /historical chain was preserved/);
  const privateValue = 'private-file-or-secret';
  assert.equal(loadoutRepairNotice({ reason: 'unavailable-faculties', removed: { modalities: [privateValue] } }).includes(privateValue), false);
});

test('expired local sessions recover through app authentication without wallet authorization', () => {
  for (const code of ['UNAUTHORIZED', 'PAIR_REQUIRED', 'PAIRING_REQUIRED', 'LOCAL_LAUNCH_REQUIRED', 'LOCAL_SESSION_EXPIRED']) {
    const view = chatFailure({ code });
    assert.equal(view.stage, 'authorization');
    assert.equal(view.action, 'connect');
    assert.equal(view.actionLabel, 'Reconnect local app');
    assert.doesNotMatch(view.message, /wallet|holdings|CPHY/i);
  }
  assert.equal(chatFailure({ code: 'SESSION_CHANGED' }).action, 'model');
  assert.equal(chatFailure({ code: 'SESSION_CHANGED' }).stage, 'authorization');
});
