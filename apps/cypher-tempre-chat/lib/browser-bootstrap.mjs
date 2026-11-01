/** Explicit operator-only setup of the pinned optional browser, without system installation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveBrowserRuntime, discoverManagedBrowserExecutable, BROWSER_INSTALL_GUIDANCE } from './browser-discovery.mjs';

const failure = (message, code = 'BROWSER_BOOTSTRAP_FAILED') => Object.assign(new Error(message), { code, status: 409 });
const ENVIRONMENT = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);

export function createBrowserBootstrap({ cacheDirectory, packageRoot, nodePath = process.execPath, environment = process.env } = {}) {
  if (!path.isAbsolute(cacheDirectory || '') || !path.isAbsolute(packageRoot || '') || !path.isAbsolute(nodePath || ''))
    throw failure('Browser setup requires private absolute installation paths.');
  let installing = null, child = null, closed = false, lastFailure = null;
  async function status() {
    const runtime = await resolveBrowserRuntime({ packageRoot });
    const installed = !!await discoverManagedBrowserExecutable({ cacheDirectory, packageRoot });
    return { state: installing ? 'installing' : installed ? 'installed' : lastFailure ? 'failed' : 'not-installed',
      version: runtime.version, revision: runtime.revision, ...(installed ? {} : { guidance: BROWSER_INSTALL_GUIDANCE }),
      ...(lastFailure ? { code: lastFailure } : {}) };
  }
  async function install() {
    if (closed) throw failure('Browser setup is closed.');
    if (installing) return installing;
    installing = (async () => {
      lastFailure = null;
      const runtime = await resolveBrowserRuntime({ packageRoot });
      if (await discoverManagedBrowserExecutable({ cacheDirectory, packageRoot })) return { ...await status(), state: 'installed' };
      await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
      const info = await fs.lstat(cacheDirectory), canonical = await fs.realpath(cacheDirectory);
      if (!info.isDirectory() || info.isSymbolicLink() || path.relative(path.resolve(cacheDirectory), canonical) ||
          process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o022))
        throw failure('Browser cache must be a private directory owned by your user.', 'BROWSER_CACHE_UNSAFE');
      if (closed) throw failure('Browser setup is closed.');
      const env = Object.fromEntries(Object.entries(environment).filter(([key]) => ENVIRONMENT.has(key.toUpperCase())));
      env.PLAYWRIGHT_BROWSERS_PATH = canonical;
      await new Promise((resolve, reject) => {
        let finished = false;
        const settle = error => { if (finished) return; finished = true; clearTimeout(timer); child = null; error ? reject(error) : resolve(); };
        child = spawn(nodePath, [runtime.cliPath, 'install', 'chromium'], { cwd: path.dirname(runtime.cliPath), env,
          shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
        const timer = setTimeout(() => { child?.kill(); settle(failure('Browser download timed out. Retry setup when the network is available.')); }, 10 * 60 * 1000);
        timer.unref?.();
        child.once('error', () => settle(failure('The bundled browser installer could not start.')));
        child.once('exit', code => settle(code === 0 && !closed ? null : failure('Browser setup did not complete. Check network access and required browser system libraries, then retry.')));
      });
      if (!await discoverManagedBrowserExecutable({ cacheDirectory, packageRoot })) throw failure('The downloaded Chromium executable could not be verified.');
      return { ...await status(), state: 'installed' };
    })().catch(error => { lastFailure = error.code || 'BROWSER_BOOTSTRAP_FAILED'; throw error; }).finally(() => { installing = null; });
    return installing;
  }
  return { status, install, async close() { closed = true; child?.kill(); await installing?.catch(() => {}); } };
}
