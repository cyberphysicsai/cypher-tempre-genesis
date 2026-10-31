import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireStartupLock, readRuntimeOwner, verifiedLaunchUrl } from '../openclaw/launcher.mjs';

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

test('a stale runtime record never sends its control token to a reused local port', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-launch-stale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ended = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  assert.equal(ended.status, 0);
  let requests = 0;
  const listener = http.createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const filename = path.join(root, 'runtime-owner.json');
  await fs.writeFile(filename, JSON.stringify({ pid: ended.pid, port: listener.address().port, token: 'a'.repeat(64), version: 'test' }));
  assert.equal(await readRuntimeOwner(filename), null);
  assert.equal(requests, 0);
  await assert.rejects(fs.access(filename), { code: 'ENOENT' });
});

test('a live unauthenticated runtime record remains available for inspection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-launch-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const listener = http.createServer((_req, res) => { res.writeHead(403); res.end('{}'); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const filename = path.join(root, 'runtime-owner.json');
  const record = JSON.stringify({ pid: process.pid, port: listener.address().port, token: 'a'.repeat(64), version: 'test' });
  await fs.writeFile(filename, record);
  await assert.rejects(readRuntimeOwner(filename), /cannot be authenticated/);
  assert.equal(await fs.readFile(filename, 'utf8'), record);
});

test('relaunch only opens the owned loopback UI with a valid single-use nonce', () => {
  const ui = 'http://127.0.0.1:8790/', nonce = 'b'.repeat(64);
  assert.equal(verifiedLaunchUrl(ui + '#launch=' + nonce, ui), ui + '#launch=' + nonce);
  for (const address of [
    'https://example.com/#launch=' + nonce,
    'http://127.0.0.1:8791/#launch=' + nonce,
    'http://localhost:8790/#launch=' + nonce,
    'http://evil@127.0.0.1:8790/#launch=' + nonce,
    ui + 'settings#launch=' + nonce,
    ui + '?key=secret#launch=' + nonce,
    ui + '#launch=invalid',
    'javascript:alert(1)',
  ]) assert.throws(() => verifiedLaunchUrl(address, ui), /launch address/);
  assert.throws(() => verifiedLaunchUrl(ui + '#launch=' + nonce, undefined), /UI address/);
});
