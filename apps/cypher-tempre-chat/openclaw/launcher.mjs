import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await fs.readFile(new URL('./upstream-lock.json', import.meta.url), 'utf8'));
const packageInfo = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const dataDir = path.resolve(process.env.CT_CHAT_DATA || path.join(root, '.local'));
const packageRoot = path.resolve(process.env.CT_OPENCLAW_MODULE || path.join(root, 'openclaw/runtime/node_modules/openclaw'));
const python = process.env.CT_CHAT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const ownerPath = path.join(dataDir, 'runtime-owner.json');
const secretEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function openPage(url) {
  if (process.env.CT_CHAT_NO_BROWSER === '1') return;
  let child;
  if (process.platform === 'win32') {
    // Start the registered browser directly through the OS URL handler; no shell text.
    child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true, stdio: 'ignore' });
  } else child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.once('error', () => { process.stderr.write('The browser could not open. ChainChat remains available at its local address.\n'); });
  child.unref();
}
async function doctor() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (!(major === 24 && (minor > 22 || minor === 22 && patch >= 1) || major >= 26 && (major > 26 || minor > 12 || minor === 12 && patch >= 1)))
    throw new Error('This edition requires the bundled Node runtime. Use the ChainChat installer or a supported OpenClaw Node version.');
  const upstream = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (upstream.name !== 'openclaw' || upstream.version !== lock.openclaw.version) throw new Error('The OpenClaw installation does not match the reviewed upstream pin.');
  const dependencies = {};
  for (const [name, expected] of Object.entries(lock.dependencyOverrides || {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('The reviewed dependency overlay is invalid.');
    const dependency = JSON.parse(await fs.readFile(path.join(packageRoot, '..', name, 'package.json'), 'utf8'));
    if (dependency.name !== name || dependency.version !== expected)
      throw new Error('The installed dependencies do not match the reviewed security overlay.');
    dependencies[name] = dependency.version;
  }
  await fs.access(path.join(packageRoot, 'openclaw.mjs'));
  await fs.access(path.join(root, 'openclaw/plugin/index.mjs'));
  await exec(python, ['-c', 'import sys; assert sys.version_info >= (3,10); import engine_bridge; print("native-engine-ok")'],
    { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }, windowsHide: true, timeout: 30_000, maxBuffer: 16384 });
  const files = JSON.parse(await fs.readFile(new URL('./engine-integrity.json', import.meta.url), 'utf8'));
  for (const [relative, expected] of Object.entries(files)) {
    const actual = createHash('sha256').update(await fs.readFile(path.join(root, 'engine/proof-of-interaction', relative))).digest('hex');
    if (actual !== expected) throw new Error('The installed native engine differs from the packaged integrity manifest.');
  }
  return { version: packageInfo.version, openclaw: upstream.version, node: process.versions.node, nativeFiles: Object.keys(files).length, dependencies };
}
export function verifiedLaunchUrl(candidate, expectedUi) {
  if (typeof expectedUi !== 'string' || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/$/.test(expectedUi))
    throw new Error('The local runtime UI address is invalid.');
  let expected, actual;
  try { expected = new URL(expectedUi); actual = new URL(candidate); }
  catch { throw new Error('The local runtime launch address is invalid.'); }
  if (!expected.port || expected.href !== expectedUi || actual.origin !== expected.origin || actual.pathname !== '/'
      || actual.username || actual.password || actual.search || !/^#launch=[a-f0-9]{64}$/.test(actual.hash))
    throw new Error('The local runtime returned an unexpected launch address.');
  return actual.href;
}
export async function readRuntimeOwner(filename = ownerPath) {
  let saved, raw;
  try { raw = await fs.readFile(filename, 'utf8'); saved = JSON.parse(raw); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('The local runtime ownership record needs inspection.'); }
  if (!saved || typeof saved !== 'object' || !Number.isSafeInteger(saved.port) || saved.port < 1 || saved.port > 65535 || !/^[a-f0-9]{64}$/.test(saved.token) || !Number.isSafeInteger(saved.pid) || saved.pid <= 0)
    throw new Error('The local runtime ownership record is invalid.');
  // Never disclose the old control token to a port reused after its owner exited.
  // A live but unauthenticated PID is retained for explicit local inspection.
  let alive = true;
  try { process.kill(saved.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
  if (!alive) {
    if (await fs.readFile(filename, 'utf8').catch(() => null) === raw) await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${saved.port}/status`, { headers: { authorization: `Bearer ${saved.token}` }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    const status = await response.json();
    if (!response.ok || status.pid !== saved.pid || status.version !== saved.version) throw new Error('Runtime identity mismatch.');
    return saved;
  } catch {
    throw new Error('A previous runtime cannot be authenticated. Stop it from its own window before starting another.');
  }
}
async function stop(existing) {
  const response = await fetch(`http://127.0.0.1:${existing.port}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${existing.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('The previous runtime did not authorize shutdown.');
  for (let i = 0; i < 150; i++) { try { await fs.access(ownerPath); } catch { return; } await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error('The previous runtime is still stopping; retry after its active work ends.');
}
export async function acquireStartupLock(startupPath) {
  if (process.platform === 'win32') {
    // A Windows named pipe releases ownership even if a launcher crashes.
    // It avoids stale lock/reclaimer files and is scoped to this installation.
    const identity = createHash('sha256').update(path.resolve(startupPath).toLowerCase()).digest('hex');
    const pipe = net.createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        pipe.once('error', reject);
        pipe.listen('\\\\.\\pipe\\cypher-tempre-start-' + identity, resolve);
      });
    } catch { throw new Error('Another ChainChat launcher is starting. Retry shortly.'); }
    return () => new Promise(resolve => pipe.close(resolve));
  }
  const claim = JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString('hex') });
  async function create() {
    const handle = await fs.open(startupPath, 'wx', 0o600);
    try { await handle.writeFile(claim); await handle.sync(); }
    catch (error) { await handle.close(); await fs.unlink(startupPath).catch(() => {}); throw error; }
    return async () => {
      await handle.close();
      if (await fs.readFile(startupPath, 'utf8').catch(() => null) === claim)
        await fs.unlink(startupPath).catch(() => {});
    };
  }
  try { return await create(); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Only one contender may reclaim a dead launcher's lock and replace it.
  const reclaimPath = startupPath + '.reclaim';
  const reclaim = await fs.open(reclaimPath, 'wx', 0o600).catch(() => {
    throw new Error('Another ChainChat launcher is starting. Retry shortly.');
  });
  try {
    let prior;
    try { prior = JSON.parse(await fs.readFile(startupPath, 'utf8')); }
    catch { throw new Error('The local startup lock needs inspection before starting.'); }
    if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0)
      throw new Error('The local startup lock needs inspection before starting.');
    let alive = true;
    try { process.kill(prior.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Another ChainChat launcher is starting. Retry shortly.');
    await fs.unlink(startupPath);
    return await create();
  } finally { await reclaim.close(); await fs.unlink(reclaimPath).catch(() => {}); }
}
export async function launch(args = process.argv.slice(2)) {
  if (args.some(arg => !['--check', '--stop'].includes(arg))) throw new Error('Usage: launcher.mjs [--check | --stop]');
  if (args.includes('--check')) { const status = await doctor(); process.stdout.write(JSON.stringify(status) + '\n'); return status; }
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const existing = await readRuntimeOwner();
  if (args.includes('--stop')) { if (existing) await stop(existing); return; }
  if (existing) {
    if (existing.version === packageInfo.version) {
      const response = await fetch(`http://127.0.0.1:${existing.port}/launch`, { method: 'POST', headers: { authorization: `Bearer ${existing.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('The local runtime refused a fresh launch.');
      const result = await response.json(); openPage(verifiedLaunchUrl(result.url, existing.ui)); return;
    }
    await stop(existing);
  }
  await doctor();
  const startupPath = path.join(dataDir, 'runtime-start.lock');
  const releaseStartup = await acquireStartupLock(startupPath);
  let app, control;
  try {
    process.env.CT_OPERATOR_TRUST_ROOT ||= path.join(dataDir, 'operator-approvals');
    const { createApp } = await import('../server.mjs');
    app = await createApp({ dataDir, publicOrigins: ['https://cyphertempre.ai', 'https://www.cyphertempre.ai'],
      openclaw: { stateDir: path.join(dataDir, 'openclaw'), packageRoot, nodePath: process.execPath, pluginPath: path.join(root, 'openclaw/plugin') } });
    const port = Number(process.env.CT_CHAT_PORT || 8790);
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
    const token = randomBytes(32).toString('hex'), ui = `http://127.0.0.1:${app.server.address().port}/`;
    let shuttingDown = false;
    async function shutdown() {
      if (shuttingDown) return; shuttingDown = true;
      // Cancels active model runs first; native atomic commitments retain receipts.
      app.server.closeAllConnections();
      await new Promise(resolve => app.server.close(resolve));
      await app.closeRuntime();
      await fs.unlink(ownerPath).catch(() => {});
      control.closeAllConnections(); await new Promise(resolve => control.close(resolve));
    }
    control = http.createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
      if (req.headers.origin || !secretEqual(String(req.headers.authorization || ''), `Bearer ${token}`)) { res.writeHead(403); res.end('{}'); return; }
      if (req.method === 'GET' && req.url === '/status') { res.end(JSON.stringify({ pid: process.pid, version: packageInfo.version })); return; }
      if (req.method === 'POST' && req.url === '/launch') { res.end(JSON.stringify({ url: ui + '#launch=' + app.issueLaunchNonce() })); return; }
      if (req.method === 'POST' && req.url === '/shutdown') { res.writeHead(202); res.end('{}'); setImmediate(() => { void shutdown(); }); return; }
      res.writeHead(404); res.end('{}');
    });
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
    await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid, port: control.address().port, token, version: packageInfo.version, appRoot: root, ui }) + '\n', { flag: 'wx', mode: 0o600 });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown(); });
    process.stdout.write(`Cypher Tempre ChainChat ${packageInfo.version} · OpenClaw ${lock.openclaw.version}\n${ui}\nPairing code: ${app.pairingCode}\n`);
    // The nonce is single-use, expires after 60s, and the page clears its fragment
    // before redeeming it. Provider credentials are never present in the URL.
    openPage(ui + '#launch=' + app.issueLaunchNonce());
    return { app, shutdown, ui };
  } catch (error) { app?.server.closeAllConnections(); app?.server.close(); await app?.closeRuntime(); control?.close(); throw error; }
  finally { await releaseStartup(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await launch(); } catch (error) {
    process.stderr.write(`ChainChat could not start: ${error.message}\n`);
    // Installed launchers have no console. Persist only a fixed diagnostic,
    // never an exception's potentially sensitive stdout, environment or text.
    const code = /^[A-Z_0-9]{1,40}$/.test(error.code || '') ? error.code : 'STARTUP_CHECK_FAILED';
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 }).then(() =>
      fs.appendFile(path.join(dataDir, 'launcher.log'),
        `${new Date().toISOString()} ChainChat ${packageInfo.version}: ${code}. Runtime did not start; run launcher.mjs --check and check the local port.\n`, { mode: 0o600 })).catch(() => {});
    process.exitCode = 1;
  }
}
