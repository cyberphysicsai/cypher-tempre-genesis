import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireStartupLock } from '../openclaw/launcher.mjs';

test('launcher permits one live owner and does not remove its startup claim', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-launch-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'start.lock');
  const release = await acquireStartupLock(filename);
  const original = await fs.readFile(filename, 'utf8').catch(() => null);
  await assert.rejects(acquireStartupLock(filename), /Another ChainChat/);
  assert.equal(await fs.readFile(filename, 'utf8').catch(() => null), original);
  await release();
  await assert.rejects(fs.access(filename), { code: 'ENOENT' });
});

test('launcher recovers a dead startup owner and serializes competing recovery', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-launch-recover-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'start.lock');
  const moduleUrl = pathToFileURL(path.resolve('openclaw/launcher.mjs')).href;
  const ended = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { acquireStartupLock } from ${JSON.stringify(moduleUrl)}; await acquireStartupLock(${JSON.stringify(filename)}); process.exit(0);`], { windowsHide: true });
  assert.equal(ended.status, 0);
  const attempts = await Promise.allSettled([acquireStartupLock(filename), acquireStartupLock(filename)]);
  const winners = attempts.filter(item => item.status === 'fulfilled');
  assert.equal(winners.length, 1);
  if (process.platform !== 'win32') assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).pid, process.pid);
  await winners[0].value();
});

test('launcher preserves malformed startup claims for local inspection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-launch-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'start.lock');
  await fs.writeFile(filename, 'invalid');
  if (process.platform === 'win32') {
    const release = await acquireStartupLock(filename);
    await release();
  } else await assert.rejects(acquireStartupLock(filename), /needs inspection/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'invalid');
});
