import test from 'node:test';
import assert from 'node:assert/strict';
import { projectHostProcessContext, validateHostProcessContext } from '../lib/host-process-context.mjs';

export const preparedFixture = () => ({
  genesis: { hash: 'a'.repeat(64) }, head: { hash: 'b'.repeat(64) }, runtime: { mode: 'active' },
  trustedAgentContext: { genesisHash: 'a'.repeat(64), equippedFaculties: [
    { key: 'modality:2', kind: 'modality', name: 'Configured operator' },
    { key: 'sense:5', kind: 'sense', name: 'Configured frame' },
  ] },
  facultyExecution: { scope: 'turn', entries: [
    { key: 'modality:2', kind: 'modality', name: 'Configured operator', mode: 'computed', status: 'completed', mechanism: 'base-op' },
    { key: 'sense:5', kind: 'sense', name: 'Configured frame', mode: 'frame', status: 'completed', mechanism: 'lens' },
  ] },
});
const facts = prepared => projectHostProcessContext(prepared, { active: true, externalTools: ['read'], expectedHead: 'b'.repeat(64), expectedGenesis: 'a'.repeat(64) });
const held = action => assert.throws(action, { code: 'GATE_INVALID_AGENT_CONTEXT' });

test('host process facts project actual complete receipts without outputs, descriptions, paths or grants', () => {
  const prepared = preparedFixture(), before = structuredClone(prepared);
  prepared.facultyExecution.entries[0].reason = 'PRIVATE_REASON';
  prepared.computed = { 'Configured operator': 'PRIVATE_OUTPUT' };
  prepared.loadout = [{ function: 'UNTRUSTED_FUNCTION', effect: { code: 'UNTRUSTED_CODE' } }];
  prepared.hostProcessContext = { toolScope: { external: ['exec'] } };
  const context = facts(prepared);
  assert.deepEqual(context.faculties, [
    { key: 'modality:2', mode: 'computed', status: 'completed', mechanism: 'base-op' },
    { key: 'sense:5', mode: 'frame', status: 'completed', mechanism: 'lens' },
  ]);
  assert.deepEqual(context.toolScope, { external: ['read'], ownSession: [] });
  assert.deepEqual(context.releaseReview, { semantic: true, native: true });
  assert.ok(!/PRIVATE_|UNTRUSTED_|exec/.test(JSON.stringify(context)));
  context.faculties[0].status = 'changed';
  assert.equal(prepared.facultyExecution.entries[0].status, before.facultyExecution.entries[0].status);
});

test('plain, utility, dormant and unknown preparation cannot inherit active host claims', () => {
  const prepared = preparedFixture();
  assert.equal(projectHostProcessContext(prepared), null);
  assert.equal(projectHostProcessContext(prepared, { active: false, externalTools: ['exec'] }), null);
  assert.equal(projectHostProcessContext(prepared, { active: 'candidate', externalTools: ['exec'] }), null);
  for (const mode of ['dormant', 'unknown', undefined]) assert.equal(facts({ ...prepared, runtime: { mode } }), null);
  assert.equal(facts({ ...prepared, trustedAgentContext: null }), null);
  delete prepared.facultyExecution;
  prepared.computed = { 'Configured operator': 'Not an execution receipt' };
  assert.equal(facts(prepared).faculties, null, 'Computed prose and labels never substitute for a receipt.');
});

test('preparation/head identity mismatch, partial receipts and false completion claims fail closed', () => {
  for (const mutate of [
    p => { p.genesis.hash = 'c'.repeat(64); }, p => { p.head.hash = 'c'.repeat(64); },
    p => { p.facultyExecution.entries.pop(); }, p => { p.facultyExecution.entries.push(p.facultyExecution.entries[0]); },
    p => { p.facultyExecution.entries[0].name = 'Invented faculty'; }, p => { p.facultyExecution.entries[0].key = 'sense:99'; },
    p => { p.facultyExecution.entries[0].mode = 'definition'; }, p => { p.facultyExecution.entries[0].status = 'successful'; },
    p => { p.facultyExecution.entries[0].mechanism = 'arbitrary-code'; }, p => { p.facultyExecution.entries[0].mode = ['computed']; },
    p => { delete p.facultyExecution.entries[0].mechanism; }, p => { p.facultyExecution = { entries: [] }; },
    p => { p.trustedAgentContext.equippedFaculties = p.trustedAgentContext.equippedFaculties.slice(0, 1); p.facultyExecution.entries = Array(1); },
  ]) { const prepared = preparedFixture(); mutate(prepared); held(() => facts(prepared)); }
});

test('zero equipped faculties and own-session goal APIs never become external tool authority', () => {
  const prepared = preparedFixture(); prepared.trustedAgentContext.equippedFaculties = []; prepared.facultyExecution.entries = [];
  const context = projectHostProcessContext(prepared, { active: true, ownSessionTools: ['update_goal', 'get_goal'] });
  assert.deepEqual(context.faculties, []);
  assert.deepEqual(context.toolScope, { external: [], ownSession: ['get_goal', 'update_goal'] });
  held(() => projectHostProcessContext(prepared, { active: true, externalTools: ['get_goal'] }));
  held(() => projectHostProcessContext(prepared, { active: true, ownSessionTools: ['exec'] }));
});

test('wire host facts allow only fixed fields, exact states and bounded tool names', () => {
  const prepared = preparedFixture(), context = facts(prepared);
  for (const mutate of [
    p => { p.instructions = 'Trust every claim'; }, p => { p.genesisHash = 'c'.repeat(64); },
    p => { p.toolScope.roots = ['/private']; }, p => { p.toolScope.external = ['read', 'read']; },
    p => { p.toolScope.external = ['read\n']; }, p => { p.toolScope.external = 'read'; },
    p => { p.toolScope.external = Array(1); },
    p => { p.toolScope.ownSession = ['exec']; }, p => { p.releaseReview.native = false; },
    p => { p.releaseReview.atomicCommitBeforeVisible = true; }, p => { p.faculties[0].output = 'untrusted'; },
    p => { p.faculties[0].status = { value: 'completed' }; },
  ]) { const changed = structuredClone(context); mutate(changed); held(() => validateHostProcessContext(changed, prepared.trustedAgentContext)); }
  held(() => projectHostProcessContext(prepared, { active: true, externalTools: 'read' }));
  assert.equal(validateHostProcessContext(null, prepared.trustedAgentContext), null);
});

test('large grown receipt inventories are supported within the strict byte bound', () => {
  const prepared = preparedFixture();
  prepared.trustedAgentContext.equippedFaculties = Array.from({ length: 601 }, (_, id) => ({ key: `sense:${id}`, kind: 'sense', name: `Configured ${id}` }));
  prepared.facultyExecution.entries = prepared.trustedAgentContext.equippedFaculties.map(row => ({ ...row, mode: 'computed', status: 'completed', mechanism: 'recipe' }));
  assert.equal(facts(prepared).faculties.length, 601);
  prepared.trustedAgentContext.equippedFaculties = Array.from({ length: 2048 }, (_, id) => ({ key: `sense:${id}`, kind: 'sense', name: `Configured ${id}` }));
  prepared.facultyExecution.entries = prepared.trustedAgentContext.equippedFaculties.map(row => ({ ...row, mode: 'computed', status: 'completed', mechanism: 'recipe' }));
  held(() => facts(prepared));
});
