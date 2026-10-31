import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolPermissions, disabledToolAuthority } from '../lib/tool-permissions.mjs';

test('tool grants default off, serialize concurrent updates, persist privately and revoke all identities of an agent', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-tool-permissions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new ToolPermissions(root).load();
  assert.deepEqual(store.get('a:genesis').grant, disabledToolAuthority());
  const grant = { enabled: true, tools: ['read'], roots: [root], networkHosts: [], allowExecution: false, acknowledged: true };
  const [a, b] = await Promise.all([store.set('a:genesis', grant), store.set('b:genesis', grant)]);
  assert.notEqual(a.revision, b.revision);
  await store.set('a:other-genesis', grant);
  a.grant.tools.push('write');
  assert.deepEqual(store.get('a:genesis').grant.tools, ['read']);
  const restored = await new ToolPermissions(root).load();
  assert.equal(restored.get('b:genesis').revision, b.revision);
  const revoked = await restored.disableRecord('a');
  assert.notEqual(revoked.revision, store.get('a:genesis').revision);
  assert.equal(restored.get('a:genesis').grant.enabled, false);
  assert.equal(restored.get('a:other-genesis').grant.enabled, false);
  assert.equal(restored.get('b:genesis').grant.enabled, true);
  assert.equal((await new ToolPermissions(root).load()).get('a:genesis').grant.enabled, false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(restored.file)).mode & 0o077, 0);
});

test('corrupt persisted authority fails closed instead of enabling or silently replacing it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-tool-permissions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'tool-permissions.json'), '{"version":99,"agents":{}}');
  await assert.rejects(new ToolPermissions(root).load(), /inspection/);
});
