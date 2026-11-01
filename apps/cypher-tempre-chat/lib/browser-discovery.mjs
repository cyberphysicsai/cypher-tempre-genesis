/** Read-only browser binary discovery. No PATH search, shell, registry or profile reads. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const BROWSER_INSTALL_GUIDANCE = 'No supported Chromium browser was found. Open Browser settings and choose Set up managed Chromium, or install Chrome, Chromium or Edge and retry. ChainChat always uses a separate owned browser profile.';

export async function resolveBrowserRuntime({ packageRoot } = {}) {
  if (!path.isAbsolute(packageRoot || '')) throw new Error('The installed native runtime is required.');
  const lock = JSON.parse(await fs.readFile(new URL('../openclaw/runtime/package-lock.json', import.meta.url), 'utf8'));
  const native = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (native.name !== 'openclaw' || native.version !== lock.packages['node_modules/openclaw']?.version)
    throw new Error('The installed native runtime does not match its reviewed lock.');
  const manifest = createRequire(path.join(packageRoot, 'package.json')).resolve('playwright-core/package.json');
  const coreRoot = path.dirname(manifest), core = JSON.parse(await fs.readFile(manifest, 'utf8'));
  if (core.name !== 'playwright-core' || core.version !== lock.packages['node_modules/playwright-core']?.version)
    throw new Error('The browser library does not match the reviewed runtime lock.');
  const browsers = JSON.parse(await fs.readFile(path.join(coreRoot, 'browsers.json'), 'utf8'));
  const chromium = browsers.browsers?.find(browser => browser.name === 'chromium');
  if (!chromium || !/^\d{1,8}$/.test(chromium.revision) || Object.keys(chromium.revisionOverrides || {}).length)
    throw new Error('The locked Chromium platform map needs review.');
  const cliPath = path.join(coreRoot, 'cli.js');
  if (!(await fs.stat(cliPath)).isFile()) throw new Error('The locked browser installer is unavailable.');
  return { cliPath, version: core.version, revision: chromium.revision };
}

export async function discoverManagedBrowserExecutable({ cacheDirectory, packageRoot, platform = process.platform, arch = process.arch, exists } = {}) {
  if (!cacheDirectory || !packageRoot || !path.isAbsolute(cacheDirectory)) return null;
  const runtime = await resolveBrowserRuntime({ packageRoot });
  const suffix = {
    'win32-x64': ['chrome-win64', 'chrome.exe'],
    'linux-x64': ['chrome-linux64', 'chrome'], 'linux-arm64': ['chrome-linux-arm64', 'chrome'],
    'darwin-x64': ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    'darwin-arm64': ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  }[platform + '-' + arch];
  if (!suffix) return null;
  const executable = path.join(cacheDirectory, 'chromium-' + runtime.revision, ...suffix);
  const present = exists || (async filename => {
    try {
      if (!(await fs.stat(filename)).isFile()) return false;
      if (!(await fs.stat(path.join(cacheDirectory, 'chromium-' + runtime.revision, 'INSTALLATION_COMPLETE'))).isFile()) return false;
      if ((await fs.lstat(cacheDirectory)).isSymbolicLink()) return false;
      const canonicalCache = await fs.realpath(cacheDirectory), canonical = await fs.realpath(filename);
      if (path.relative(path.resolve(cacheDirectory), canonicalCache)) return false;
      const relative = path.relative(canonicalCache, canonical);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
      await fs.access(filename, platform === 'win32' ? constants.F_OK : constants.X_OK); return true;
    } catch { return false; }
  });
  return await present(executable) ? executable : null;
}

export async function discoverBrowserExecutable({ cacheDirectory, packageRoot, platform = process.platform, arch = process.arch, env = process.env, exists } = {}) {
  const managed = await discoverManagedBrowserExecutable({ cacheDirectory, packageRoot, platform, arch, exists });
  if (managed) return managed;
  const candidates = [];
  const windowsVariable = name => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const localWindowsRoot = value => typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) && !/[\0\r\n]/.test(value) ? path.win32.normalize(value) : null;
  if (platform === 'win32') {
    const program = [...new Set([windowsVariable('ProgramW6432'), windowsVariable('ProgramFiles'), 'C:\\Program Files'].map(localWindowsRoot).filter(Boolean))];
    const program32 = [...new Set([windowsVariable('ProgramFiles(x86)'), 'C:\\Program Files (x86)'].map(localWindowsRoot).filter(Boolean))];
    for (const directory of program) candidates.push(path.win32.join(directory, 'Google/Chrome/Application/chrome.exe'));
    for (const directory of [...program32, ...program]) candidates.push(path.win32.join(directory, 'Microsoft/Edge/Application/msedge.exe'));
    const local = localWindowsRoot(windowsVariable('LOCALAPPDATA'));
    if (local) for (const relative of ['Google/Chrome/Application/chrome.exe', 'Chromium/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']) candidates.push(path.win32.join(local, relative));
  } else if (platform === 'darwin') {
    const roots = ['/Applications'];
    if (typeof env.HOME === 'string' && path.posix.isAbsolute(env.HOME) && !/[\0\r\n]/.test(env.HOME)) roots.push(path.posix.join(env.HOME, 'Applications'));
    for (const directory of roots) for (const [bundle, executable] of [['Google Chrome', 'Google Chrome'], ['Chromium', 'Chromium'], ['Microsoft Edge', 'Microsoft Edge']])
      candidates.push(path.posix.join(directory, bundle + '.app', 'Contents/MacOS', executable));
  } else if (platform === 'linux') {
    candidates.push('/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge', '/opt/google/chrome/chrome', '/opt/microsoft/msedge/msedge', '/snap/bin/chromium');
  } else return null;
  const present = exists || (async filename => {
    try { if (!(await fs.stat(filename)).isFile()) return false; await fs.access(filename, platform === 'win32' ? constants.F_OK : constants.X_OK); return true; }
    catch { return false; }
  });
  for (const filename of new Set(candidates)) if (await present(filename)) return filename;
  return null;
}
