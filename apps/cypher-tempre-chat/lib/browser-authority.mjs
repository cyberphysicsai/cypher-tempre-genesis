import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { discoverBrowserExecutable, BROWSER_INSTALL_GUIDANCE } from './browser-discovery.mjs';
import { launchOwnedBrowser } from './browser-launcher.mjs';
export { expandBrowserActions } from '../openclaw/plugin/browser-actions.mjs';

const fail = message => Object.assign(new Error(message), { code: 'BROWSER_AUTHORITY_DENIED', status: 403 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const within = (root, file) => { const relative = path.relative(root, file); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const sensitive = /password|passphrase|one.?time.?code|api.?key|access.?token|private.?key|seed.?phrase|mnemonic|credit.?card|card.?number|cc-number|cc-csc/i;
const payment = /connect.?wallet|sign.?transaction|approve.?allowance|send.?funds|confirm.?payment|purchase|checkout/i;
const ACTIONS = new Set(['doctor', 'status', 'start', 'stop', 'profiles', 'tabs', 'open', 'focus', 'close', 'snapshot', 'screenshot', 'navigate', 'console', 'requests', 'errors', 'text', 'emulate', 'pdf', 'download', 'waitfordownload', 'upload', 'dialog', 'act']);
const KINDS = new Set(['click', 'clickCoords', 'type', 'press', 'hover', 'scrollIntoView', 'drag', 'select', 'fill', 'resize', 'wait', 'evaluate', 'close', 'batch']);
const FIELDS = new Set(['action', 'target', 'profile', 'targetUrl', 'targetId', 'label', 'limit', 'maxChars', 'mode', 'snapshotFormat', 'refs', 'interactive', 'compact', 'depth', 'frame', 'labels', 'fullPage', 'element', 'type', 'urls', 'path', 'level', 'filter', 'clear', 'query', 'device', 'colorScheme', 'timezoneId', 'locale', 'paths', 'inputRef', 'dialogId', 'accept', 'promptText', 'kind', 'ref', 'actions', 'stopOnError', 'doubleClick', 'button', 'modifiers', 'x', 'y', 'text', 'submit', 'slowly', 'key', 'delayMs', 'startRef', 'endRef', 'values', 'fields', 'width', 'height', 'timeMs', 'selector', 'url', 'loadState', 'textGone', 'timeoutMs', 'fn', 'request']);

export const OWNED_BROWSER_PROFILE = 'chainchat-owned';
export function publicBrowserAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 2, 168].includes(b) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (net.isIP(address) === 6) {
    const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    const [first, second = '0'] = normalized.split(':');
    return /^[23][0-9a-f]{0,3}:/.test(normalized) && first !== '2002' && parseInt(first, 16) < 0x3ff0 &&
      !(first === '2001' && (parseInt(second || '0', 16) < 0x200 || second === 'db8'));
  }
  return false;
}

function hostName(value) {
  if (typeof value !== 'string' || value.length > 253 || /[\s\/:@?#*\\]/.test(value)) throw fail('Browser grants require exact public hostnames.');
  const host = new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || net.isIP(host) || /(?:^|\.)(?:localhost|local|internal)$/.test(host) || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw fail('Private names, IP literals and wildcard browser grants are denied.');
  return host;
}

/** Test transport is constructor-only, never accepted in a grant/action.
 * It maps fixture.test to a disposable local HTTP server. Production has no
 * localhost/private-network opt-in and always verifies/pins public DNS.
 */
export async function createBrowserAuthority({ directory, packageRoot, cacheDirectory, executablePath, chromium: suppliedChromium, ownerId,
  grant, assertCurrent, authorizeAction, inspectNativeTarget, onEvent = () => {}, operatorGrant = {}, protectedRoots = [], testTransport,
  launchBrowser = launchOwnedBrowser } = {}) {
  if (typeof assertCurrent !== 'function' || typeof authorizeAction !== 'function' || !path.isAbsolute(directory || '') ||
      typeof ownerId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(ownerId)) throw fail('A private owned browser directory and action authority are required.');
  if (inspectNativeTarget !== undefined && typeof inspectNativeTarget !== 'function') throw fail('Native reference inspection must be a private callback.');
  const ownedGrant = structuredClone(grant || {});
  if (ownedGrant.enabled !== true || ownedGrant.acknowledged !== true || !ownedGrant.tools?.includes('browser') ||
      !Array.isArray(ownedGrant.networkHosts) || !ownedGrant.networkHosts.length || ownedGrant.networkHosts.length > 32) throw fail('No current explicit browser grant exists.');
  const hosts = Object.freeze([...new Set(ownedGrant.networkHosts.map(hostName))]);
  const operator = Object.freeze({ evaluate: operatorGrant.evaluate === true, credentials: operatorGrant.credentials === true, payments: operatorGrant.payments === true });
  const fixture = testTransport;
  if (fixture && (!process.env.NODE_TEST_CONTEXT || !plain(fixture) || Object.keys(fixture).some(key => key !== 'fixtures') || !plain(fixture.fixtures))) throw fail('Private-network injection is available only inside the Node test runner.');
  const lookup = dns.lookup;
  if (launchBrowser !== launchOwnedBrowser && !process.env.NODE_TEST_CONTEXT) throw fail('A test browser launcher is available only inside the Node test runner.');
  let closed = false, context = null, proxy = null, cdpUrl = null, starting = null, transport = null;
  const privateValues = new Set();
  const sockets = new Set(), pages = new Map(), references = new Map(), dialogs = new Map(), network = [];
  let sequence = Promise.resolve(), pageNumber = 0;
  const report = (status, label) => { try { onEvent({ status, label }); } catch {} };
  async function current() { if (closed) throw fail('The owned browser is closed.'); await assertCurrent(); }
  function checkedUrl(value) {
    let url; try { url = new URL(value); } catch { throw fail('Browser requests require an explicit network URL.'); }
    const host = hostName(url.hostname);
    const mapping = fixture?.fixtures?.[host];
    if (!hosts.includes(host) || url.username || url.password ||
        (mapping ? !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || Number(url.port || (url.protocol === 'http:' || url.protocol === 'ws:' ? 80 : 443)) !== mapping.port :
          !['https:', 'wss:'].includes(url.protocol) || url.port && url.port !== '443')) throw fail('The browser destination has no matching network grant.');
    return url;
  }
  async function targetFor(value) {
    await current(); const url = checkedUrl(value), mapping = fixture?.fixtures?.[url.hostname];
    if (mapping) {
      if (mapping.address !== '127.0.0.1' || !Number.isInteger(mapping.port) || mapping.port < 1 || mapping.port > 65535) throw fail('Invalid disposable loopback fixture.');
      return { url, address: mapping.address, port: mapping.port };
    }
    const results = await lookup(url.hostname, { all: true, verbatim: true });
    if (!results.length || results.some(result => !publicBrowserAddress(result.address))) throw fail('Private/reserved browser destinations are denied.');
    return { url, address: results[0].address, port: 443 };
  }
  function track(socket) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); return socket; }
  async function startProxy() {
    const credentials = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
    privateValues.add(credentials); privateValues.add(password);
    const expectedAuth = `Basic ${Buffer.from(`${credentials}:${password}`).toString('base64')}`;
    proxy = http.createServer(async (request, response) => {
      try {
        if (request.headers['proxy-authorization'] !== expectedAuth) { response.writeHead(407, { 'proxy-authenticate': 'Basic realm="ChainChat owned browser"' }); response.end(); return; }
        await current();
        const target = await targetFor(request.url);
        await current();
        if (target.url.protocol !== 'http:' || !fixture?.fixtures?.[target.url.hostname]) throw fail('Plain HTTP is restricted to disposable tests.');
        const headers = { ...request.headers, host: target.url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
        const upstream = http.request({ hostname: target.address, port: target.port, method: request.method, path: target.url.pathname + target.url.search, headers,
          agent: false, timeout: 15000 }, incoming => { response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response); });
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        upstream.on('timeout', () => upstream.destroy()); request.pipe(upstream);
      } catch { response.writeHead(403); response.end('Browser network request denied.'); }
    });
    proxy.on('connect', async (request, client, head) => {
      track(client);
      try {
        if (request.headers['proxy-authorization'] !== expectedAuth) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="ChainChat owned browser"\r\n\r\n'); return; }
        await current();
        const target = await targetFor(`https://${request.url}/`);
        await current();
        const upstream = track(net.connect({ host: target.address, port: target.port }));
        upstream.setTimeout(60000, () => upstream.destroy());
        upstream.once('connect', async () => {
          try { await current(); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream); }
          catch { upstream.destroy(); client.destroy(); }
        });
        client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
      } catch { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
    });
    proxy.on('connection', track); proxy.on('upgrade', (_request, socket) => socket.destroy());
    proxy.requestTimeout = 15000; proxy.headersTimeout = 10000;
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    return { server: `http://127.0.0.1:${proxy.address().port}`, username: credentials, password, bypass: '<-loopback>' };
  }
  function registerPage(page) {
    if ([...pages.values()].includes(page)) return;
    const id = `tab-${++pageNumber}`; pages.set(id, page);
    page.on('close', () => { pages.delete(id); for (const [ref, entry] of references) if (entry.page === page) references.delete(ref); });
    // Keep native dialog handling available when a second SDK CDP client
    // attaches; this owner connection must not auto-dismiss its dialogs.
    page.on('dialog', dialog => { dialogs.set(page, { type: dialog.type(), message: dialog.message().slice(0, 2000) }); });
  }
  async function start() {
    await current(); if (context) return { profile: OWNED_BROWSER_PROFILE, cdpUrl };
    if (starting) return starting;
    starting = (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (path.relative(await fs.realpath(directory), path.resolve(directory)) || (await fs.lstat(directory)).isSymbolicLink()) throw fail('Browser data must use its own real directory.');
      const marker = path.join(directory, 'chainchat-owner.json');
      try { const saved = JSON.parse(await fs.readFile(marker, 'utf8')); if (saved.ownerId !== ownerId || saved.version !== 1) throw fail('This browser profile belongs to another owner.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; if ((await fs.readdir(directory)).length) throw fail('An existing personal browser profile cannot be adopted.');
        await fs.writeFile(marker, JSON.stringify({ version: 1, ownerId }), { mode: 0o600, flag: 'wx' }); }
      const chromium = suppliedChromium || createRequire(path.join(packageRoot, 'package.json'))('playwright-core').chromium;
      const selectedExecutable = executablePath || await discoverBrowserExecutable({ cacheDirectory, packageRoot });
      if (!selectedExecutable) throw Object.assign(new Error(BROWSER_INSTALL_GUIDANCE), { code: 'BROWSER_NOT_INSTALLED', status: 409 });
      const browserProxy = await startProxy();
      const downloadsPath = path.join(directory, 'downloads'); await fs.mkdir(downloadsPath, { recursive: true, mode: 0o700 });
      transport = await launchBrowser({ directory, executablePath: selectedExecutable, chromium, packageRoot,
        proxy: browserProxy, assertCurrent: current, downloadsPath });
      context = transport.context; cdpUrl = transport.cdpUrl; privateValues.add(cdpUrl);
      for (const value of transport.redactionSecrets?.() || []) privateValues.add(value);
      const denyUnproxiedProtocols = () => {
        for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
          try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
        }
        // This owned context never equips page-provided service workers. The
        // proxy independently contains worker traffic even if a page probes
        // an alternative browser API or a retained profile has older state.
        try { Object.defineProperty(Navigator.prototype, 'serviceWorker', { value: undefined, configurable: false, writable: false }); } catch {}
      };
      await context.addInitScript(denyUnproxiedProtocols);
      await Promise.all(context.pages().map(page => page.evaluate(denyUnproxiedProtocols)));
      await context.route('**/*', async route => {
        try {
          await current(); const url = checkedUrl(route.request().url());
          network.push({ host: url.hostname, method: route.request().method(), status: 'allowed' });
          if (network.length > 200) network.shift(); await route.continue();
        } catch { network.push({ status: 'denied' }); if (network.length > 200) network.shift(); await route.abort('blockedbyclient').catch(() => {}); }
      });
      await context.routeWebSocket('**/*', async route => {
        try { await current(); checkedUrl(route.url()); route.connectToServer(); }
        catch { await route.close({ code: 1008, reason: 'Browser network scope denied' }).catch(() => {}); }
      });
      context.on('page', registerPage); context.pages().forEach(registerPage);
      context.once('close', () => { context = null; cdpUrl = null; if (!closed) void close(); });
      report('ready', 'Owned browser started with proxy and per-request network containment');
      return { profile: OWNED_BROWSER_PROFILE, cdpUrl };
    })();
    try { return await starting; } catch (error) { await close(); throw error; } finally { starting = null; }
  }
  async function fileAllowed(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.startsWith('\\\\') || file.startsWith('//')) throw fail('Uploads require an explicitly granted local file.');
    const real = await fs.realpath(file), stat = await fs.stat(real);
    const roots = await Promise.all((ownedGrant.roots || []).map(async root => {
      if (typeof root !== 'string' || !path.isAbsolute(root) || root.startsWith('\\\\') || root.startsWith('//')) throw fail('Browser file grants must be local real directories.');
      const canonical = await fs.realpath(root);
      if (path.relative(path.resolve(root), canonical)) throw fail('A granted upload directory changed its canonical location.');
      return canonical;
    }));
    const blocked = await Promise.all([directory, ...protectedRoots].map(root => fs.realpath(root).catch(() => path.resolve(root))));
    if (!stat.isFile() || stat.nlink > 1 || !roots.some(root => within(root, real)) || blocked.some(root => within(root, real))) throw fail('Upload file is outside this browser grant.');
    return real;
  }
  async function inspectAction(input) {
    await current();
    if (!plain(input) || Buffer.byteLength(JSON.stringify(input)) > 128 * 1024 || Object.keys(input).some(key => !FIELDS.has(key)) || !ACTIONS.has(input.action) || input.target && input.target !== 'host' || input.profile && !['openclaw', OWNED_BROWSER_PROFILE].includes(input.profile)) throw fail('Browser actions must stay in the owned profile.');
    const params = structuredClone(input); params.profile = OWNED_BROWSER_PROFILE; params.target = 'host';
    const act = params.request || params;
    if (params.request && (!plain(params.request) || Object.keys(params.request).some(key => !FIELDS.has(key) || ['profile', 'target', 'paths', 'path'].includes(key)))) throw fail('Unsupported nested browser authority fields.');
    if (params.action === 'act' && (!KINDS.has(act.kind) || act.kind === 'batch')) throw fail('Each native batch member requires its own fresh PoI action review.');
    if (act.kind === 'fill' && Array.isArray(act.fields) && act.fields.length > 1) throw fail('Every form field requires its own fresh PoI action review.');
    const requestsCode = act.kind === 'evaluate' || [params, act].some(object => Object.hasOwn(object, 'fn'));
    if (requestsCode && !operator.evaluate) throw fail('Renderer JavaScript requires an explicit operator grant.');
    if (requestsCode && (!operator.credentials || !operator.payments)) throw fail('Arbitrary renderer code requires the sensitive-action acknowledgements; keyword checks cannot constrain obfuscated code.');
    if (!operator.credentials && sensitive.test(JSON.stringify(params))) throw fail('Credential entry requires a local operator handoff.');
    if (!operator.payments && payment.test(JSON.stringify(params))) throw fail('Payment or wallet actions require a local operator handoff.');
    for (const object of [params, act]) for (const key of ['targetUrl', 'url']) if (object[key] !== undefined) {
      // A blank owned tab carries no network authority. Network navigation is
      // a separate primitive so upstream can inspect every redirect in Playwright.
      if (object === params && params.action === 'open' && key === 'targetUrl' && object[key] === 'about:blank') continue;
      object[key] = checkedUrl(object[key]).href;
    }
    if (params.paths) { if (!Array.isArray(params.paths) || params.paths.length > 20) throw fail('Bounded upload files are required.'); params.paths = await Promise.all(params.paths.map(fileAllowed)); }
    if (params.path) {
      const downloads = path.join(directory, 'downloads'); await fs.mkdir(downloads, { recursive: true, mode: 0o700 });
      const file = path.resolve(downloads, path.basename(params.path));
      if (!within(downloads, file) || file === downloads || path.isAbsolute(params.path) && path.resolve(params.path) !== file) throw fail('Downloads stay in the owned browser directory.');
      params.path = file;
    }
    const tabs = [];
    if (context) for (const [targetId, page] of pages) {
      const client = await context.newCDPSession(page);
      try { const { targetInfo } = await client.send('Target.getTargetInfo'); tabs.push({ targetId: targetInfo.targetId, localId: targetId, url: page.url() }); }
      finally { await client.detach().catch(() => {}); }
    }
    const targets = [];
    const activatesLink = ['click', 'clickCoords'].includes(act.kind) || act.kind === 'press' && /(?:^|\+)(?:Enter|Space| )$/.test(act.key || '');
    const checkLinkDestination = (info, observedUrl) => {
      if (!activatesLink || !info.href?.trim() || info.href.trim().startsWith('#')) return;
      let destination; try { destination = new URL(info.href, observedUrl); }
      catch { throw fail('The observed link destination is invalid.'); }
      // Browser grants do not authorize launching OS protocol handlers or
      // JavaScript/file destinations. Buttons without href remain unchanged.
      checkedUrl(destination.href);
    };
    if (params.action === 'act' && !['wait', 'resize', 'evaluate', 'close'].includes(act.kind)) {
      const selectedId = act.targetId || params.targetId;
      if (act.targetId && params.targetId && act.targetId !== params.targetId) throw fail('Browser target identifiers must agree.');
      const selected = selectedId ? tabs.find(tab => tab.targetId === selectedId || tab.localId === selectedId) : tabs.filter(tab => tab.url !== 'about:blank').length === 1 ? tabs.find(tab => tab.url !== 'about:blank') : null;
      if (!selected) throw fail('An unambiguous owned browser targetId is required.');
      const page = pages.get(selected.localId), selectors = [act.ref, act.startRef, act.endRef, act.inputRef, ...(act.fields || []).map(field => field.ref)].filter(Boolean);
      const elements = [], nativeTargets = [];
      for (const ref of selectors) {
        if (references.has(ref)) elements.push(await elementFor(page, { ref }));
        else {
          const normalized = String(ref).replace(/^@|^ref=/, '');
          if (!/^[a-zA-Z0-9_-]{1,128}$/.test(normalized)) throw fail('Invalid native browser element reference.');
          const marked = await page.$$(`[data-openclaw-browser-ref="${normalized}"]`);
          if (marked.length === 1) elements.push(marked[0]);
          else {
            const locator = page.locator(`aria-ref=${normalized}`), element = await locator.elementHandle({ timeout: 1500 }).catch(() => null);
            if (element) elements.push(element);
            else {
              if (!inspectNativeTarget) throw fail('The native browser reference needs a fresh snapshot.');
              // Resolve the exact reference in the original native client's
              // cache. Label matching cannot establish that element identity.
              const info = await inspectNativeTarget({ targetId: selected.targetId, ref: normalized });
              if (!plain(info) || info.connected !== true || info.url !== selected.url) throw fail('The native browser document changed during reference inspection.');
              if (info.url !== 'about:blank') checkedUrl(info.url);
              nativeTargets.push({ ...info, nativeRef: normalized, nativeTargetId: selected.targetId });
            }
          }
        }
      }
      if (!elements.length && act.selector) elements.push(await elementFor(page, { selector: act.selector }));
      if (!elements.length && act.kind === 'press') {
        const active = await page.evaluateHandle(() => document.activeElement);
        if (active.asElement()) elements.push(active.asElement());
      }
      if (!elements.length && act.kind === 'clickCoords') {
        if (!Number.isFinite(act.x) || !Number.isFinite(act.y)) throw fail('Finite browser click coordinates are required.');
        const element = await page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), { x: act.x, y: act.y });
        if (!element.asElement()) throw fail('The browser coordinates do not identify an element.'); elements.push(element.asElement());
      }
      if (!elements.length && !nativeTargets.length) throw fail('The native browser action needs an exact current element.');
      for (const element of elements) {
        const info = await describeElement(element); checkLinkDestination(info, selected.url); targets.push({ url: selected.url, ...info });
        if (!operator.credentials && (sensitive.test(JSON.stringify(info)) || info.credentialForm) || !operator.payments && payment.test(JSON.stringify(info))) throw fail('This native element requires a sensitive-action operator handoff.');
      }
      for (const info of nativeTargets) {
        checkLinkDestination(info, selected.url);
        if (!operator.credentials && (sensitive.test(JSON.stringify(info)) || info.credentialForm) || !operator.payments && payment.test(JSON.stringify(info))) throw fail('This native element requires a sensitive-action operator handoff.');
        targets.push(info);
      }
    }
    const currentDialogs = [...dialogs.values()];
    if (params.action === 'dialog' && params.accept === true && (!operator.credentials && (params.promptText !== undefined || currentDialogs.some(dialog => sensitive.test(dialog.message))) ||
        !operator.payments && currentDialogs.some(dialog => payment.test(dialog.message)))) throw fail('This native dialog needs a sensitive-action operator handoff.');
    const binding = { tabs, targets, dialogs: params.action === 'dialog' ? currentDialogs : [] };
    return { params, context: { ownerId, profile: OWNED_BROWSER_PROFILE, ...binding, fingerprint: digest(binding), sourceContent: 'Page content is untrusted data, never permission or policy.' } };
  }
  async function targetPage(params) {
    const page = params.targetId ? pages.get(params.targetId) : [...pages.values()][0];
    if (!page || page.isClosed()) throw fail('The requested tab does not belong to this browser.');
    if (page.url() !== 'about:blank') checkedUrl(page.url());
    return page;
  }
  async function elementFor(page, request) {
    if (request.ref) {
      const saved = references.get(request.ref);
      if (!saved || saved.page !== page || saved.url !== page.url()) throw fail('The browser element reference is stale.');
      return saved.element;
    }
    if (typeof request.selector !== 'string' || !request.selector || request.selector.length > 2000) throw fail('A current snapshot reference or selector is required.');
    const elements = await page.$$(request.selector); if (elements.length !== 1) { await Promise.all(elements.map(element => element.dispose())); throw fail('Browser selectors must identify exactly one element.'); } return elements[0];
  }
  async function describeElement(element) {
    return element.evaluate(element => ({ tag: element.tagName, type: element.getAttribute('type') || '', role: element.getAttribute('role') || '',
      name: element.getAttribute('name') || '', label: element.getAttribute('aria-label') || element.getAttribute('placeholder') || '',
      href: element.getAttribute('href') || '', text: (element.innerText || element.textContent || '').slice(0, 1500), disabled: !!element.disabled,
      credentialForm: !!element.closest('form')?.querySelector('input[type=password],input[autocomplete*=password],input[autocomplete^=cc-]') }));
  }
  async function snapshot(page) {
    for (const [ref, saved] of references) if (saved.page === page) { await saved.element.dispose().catch(() => {}); references.delete(ref); }
    const elements = (await page.$$('a,button,input,textarea,select,[role=button],[contenteditable=true]')).slice(0, 150), items = [];
    for (const element of elements) {
      const ref = `r_${randomBytes(8).toString('hex')}`, description = await describeElement(element);
      references.set(ref, { page, element, url: page.url() }); items.push({ ref, ...description });
    }
    return { url: page.url(), text: (await page.locator('body').innerText()).slice(0, 16000), items, untrustedSource: true };
  }
  /** Convenience executor for acceptance and non-native callers. The production
   * native SDK can use start/inspectAction and retain its own full action tool.
   */
  function execute(input, { callId } = {}) {
    const operation = sequence.then(async () => {
      await start(); const inspected = await inspectAction(input), params = inspected.params;
      const page = params.action === 'open' ? null : await targetPage(params), request = params.request || params;
      let element = null, target = null;
      if (params.action === 'act' && ['click', 'type', 'press', 'hover', 'select', 'fill', 'scrollIntoView'].includes(request.kind)) {
        element = await elementFor(page, request); target = await describeElement(element);
        if (!operator.credentials && (sensitive.test(JSON.stringify(target)) || target.credentialForm) || !operator.payments && payment.test(JSON.stringify(target))) throw fail('This element requires a sensitive-action operator handoff.');
      }
      const originalUrl = page?.url(), targetDigest = target ? digest(target) : null;
      const proposal = { name: 'browser', callId, params };
      if (typeof callId !== 'string' || !callId || callId.length > 256) throw fail('A bound browser call identifier is required.');
      const approval = await authorizeAction(proposal, { ...inspected.context, currentUrl: originalUrl, target, targetFingerprint: targetDigest });
      if (approval?.allowed !== true) throw fail('The Proof of Interaction gate withheld this browser action.');
      await current(); if (page && page.url() !== originalUrl || element && digest(await describeElement(element)) !== targetDigest) throw fail('The browser target changed during action review.');
      report('started', `Native browser ${params.action === 'act' ? request.kind : params.action}`);
      let result;
      if (params.action === 'open') { const opened = await context.newPage(); registerPage(opened); await opened.goto(params.targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }); checkedUrl(opened.url()); result = { targetId: [...pages].find(([, value]) => value === opened)[0], url: opened.url() }; }
      else if (params.action === 'navigate') { await page.goto(params.targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }); checkedUrl(page.url()); result = { url: page.url() }; }
      else if (params.action === 'snapshot' || params.action === 'text') result = await snapshot(page);
      else if (params.action === 'tabs') result = [...pages].map(([targetId, tab]) => ({ targetId, url: tab.url() }));
      else if (params.action === 'screenshot') result = { mimeType: 'image/png', data: (await page.screenshot({ timeout: 10000 })).toString('base64') };
      else if (params.action === 'close') { await page.close(); result = { closed: true }; }
      else if (params.action === 'act') {
        const options = { timeout: 10000 };
        if (request.kind === 'click') await element.click(options);
        else if (request.kind === 'type' || request.kind === 'fill') { await element.fill(request.text ?? '', options); if (request.submit) await element.press('Enter', options); }
        else if (request.kind === 'press') await element.press(request.key, options);
        else if (request.kind === 'hover') await element.hover(options);
        else if (request.kind === 'select') await element.selectOption(request.values, options);
        else if (request.kind === 'scrollIntoView') await element.scrollIntoViewIfNeeded(options);
        else if (request.kind === 'evaluate') result = await page.evaluate(request.fn);
        else if (request.kind === 'wait') await page.waitForTimeout(Math.min(request.timeMs || 0, 5000));
        else throw fail('Use the original native browser tool for this action.');
        result ??= { completed: true, url: page.url() };
      } else throw fail('Use the original native browser tool for this action.');
      report('completed', `Native browser ${params.action === 'act' ? request.kind : params.action} returned`);
      return result;
    });
    sequence = operation.catch(() => {}); return operation;
  }
  async function close() {
    if (closed) return; closed = true;
    for (const socket of sockets) socket.destroy();
    await context?.close().catch(() => {}); context = null;
    await transport?.close().catch(() => {}); transport = null;
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proxy = null; }
  }
  return { start, inspectAction,
    async assertActionUnchanged(input, fingerprint) { const current = await inspectAction(input); if (current.context.fingerprint !== fingerprint) throw fail('The native browser target changed during review.'); return current; },
    pauseNetwork() { for (const socket of sockets) socket.destroy(); },
    execute, close, redactionSecrets: () => [...privateValues],
    describe: () => ({ profile: OWNED_BROWSER_PROFILE, isolated: true, running: !!context, closed, networkHosts: [...hosts], network: [...network] }) };
}
