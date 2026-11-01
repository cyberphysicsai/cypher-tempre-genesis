import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const publicFailures = new WeakSet();
const denied = message => { const error = Object.assign(new Error(message), { code: 'BROWSER_START_FAILED', status: 409 }); publicFailures.add(error); return error; };
const environmentKeys = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USER', 'LOGNAME',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'TZ', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'DBUS_SESSION_BUS_ADDRESS']);
export function browserEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => environmentKeys.has(key.toUpperCase()) && typeof value === 'string'));
}

/** Own the Chromium process as well as its profile. Neither Playwright client
 * receives generic HTTP credentials: the CDP relay answers only challenges
 * from the exact private proxy, never WWW-Authenticate challenges from sites.
 */
export async function launchOwnedBrowser({ executablePath, directory, proxy, chromium, packageRoot, assertCurrent, downloadsPath, onDiagnostic }) {
  let proxyURL; try { proxyURL = new URL(proxy?.server); } catch {}
  if (!path.isAbsolute(executablePath || '') || !path.isAbsolute(directory || '') || !path.isAbsolute(packageRoot || '') ||
      downloadsPath !== path.join(directory, 'downloads') || !chromium?.connectOverCDP || typeof assertCurrent !== 'function' ||
      !proxyURL || proxyURL.protocol !== 'http:' || proxyURL.hostname !== '127.0.0.1' || !proxyURL.port ||
      proxyURL.username || proxyURL.password || proxyURL.pathname !== '/' || proxyURL.search || proxyURL.hash ||
      !/^[a-f0-9]{48}$/.test(proxy?.username || '') || !/^[a-f0-9]{48}$/.test(proxy?.password || ''))
    throw denied('An owned executable, profile and current browser authority are required.');
  const profile = path.join(directory, 'profile');
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  try {
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(profile)).isSymbolicLink() || path.relative(await fs.realpath(profile), path.resolve(profile)))
      throw denied('The owned Chromium profile must be a real private directory.');
    await fs.rm(activePortFile, { force: true }); await assertCurrent();
  } catch (error) { if (publicFailures.has(error)) throw error; throw denied('The owned Chromium profile could not be prepared.'); }
  const child = spawn(executablePath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, `--proxy-server=${proxy.server}`, '--proxy-bypass-list=<-loopback>',
    '--disable-quic', '--disable-extensions', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-breakpad', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
    '--password-store=basic', '--use-mock-keychain',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-features=WebTransport,WebTransportDeveloperMode,WebRtcHideLocalIpsWithMdns', 'about:blank',
  ], { windowsHide: true, env: browserEnvironment(), stdio: ['ignore', 'ignore', 'pipe'] });
  // Drain bounded diagnostics without exposing owned profile paths publicly.
  let stderr = '', exit = null, spawnError = null;
  child.stderr?.on('data', value => { stderr = (stderr + value.toString()).slice(-4096); });
  const exited = new Promise(resolve => {
    child.once('error', error => { spawnError = error; resolve(); });
    child.once('exit', (code, signal) => { exit = { code, signal }; resolve(); });
  });
  let relay = null, browser = null, closed = false, upstreamURL = null, WebSocketClass = null;
  async function close() {
    if (closed) return; closed = true;
    // Stop this exact owned browser gracefully, even after its invocation lease
    // has expired. This private cleanup socket can issue only Browser.close.
    if (upstreamURL && WebSocketClass && child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const socket = new WebSocketClass(upstreamURL, { perMessageDeflate: false, maxPayload: 1024 * 1024, handshakeTimeout: 1000 });
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1500);
        const finish = () => { clearTimeout(timer); resolve(); };
        socket.once('open', () => { socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }), () => {}); });
        socket.once('error', finish); socket.once('close', finish);
      });
    }
    await relay?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(1500)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited, delay(1500)]); }
    }
  }
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await assertCurrent();
      if (spawnError || exit) throw denied(/sandbox|apparmor|user.?namespace/i.test(stderr)
        ? 'Chromium could not start its sandbox. Check the managed Chromium installation and host sandbox policy.'
        : 'The owned Chromium process exited before its private transport became ready.');
      try {
        const [portText, browserPath] = (await fs.readFile(activePortFile, 'utf8')).trim().split(/\r?\n/);
        const port = Number(portText);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]{8,128}$/.test(browserPath || ''))
          throw denied('Chromium returned an invalid private transport.');
        upstreamURL = `ws://127.0.0.1:${port}${browserPath}`; break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(75);
    }
    if (!upstreamURL) throw denied('The owned Chromium private transport did not become ready.');
    const { createBrowserCDPRelay } = await import('./browser-cdp-relay.mjs');
    const { WebSocket, WebSocketServer } = createRequire(path.join(packageRoot, 'package.json'))('ws');
    WebSocketClass = WebSocket;
    relay = createBrowserCDPRelay({ upstreamURL, proxyOrigin: proxy.server,
      credentials: { username: proxy.username, password: proxy.password }, WebSocket, WebSocketServer, assertCurrent, onDiagnostic });
    const endpoint = await relay.start();
    browser = await chromium.connectOverCDP(endpoint.webSocketURL, { timeout: 20000 });
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw denied('Chromium did not expose exactly one owned persistent context.');
    const context = contexts[0];
    // The owner enforces routing and service-worker policy across all later
    // native clients attached to the same persistent browser context.
    await context.clearPermissions();
    const client = await browser.newBrowserCDPSession();
    try { await client.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadsPath, eventsEnabled: true }); }
    finally { await client.detach(); }
    return { context, cdpUrl: endpoint.webSocketURL, close,
      redactionSecrets: () => [upstreamURL, ...relay.privateValues()] };
  } catch (error) {
    await close();
    // Dependency errors can contain the private CDP capability URL. It must
    // never become a public startup error, including before service registration.
    if (publicFailures.has(error)) throw error;
    throw denied('The owned Chromium secure transport could not be initialized.');
  }
}
