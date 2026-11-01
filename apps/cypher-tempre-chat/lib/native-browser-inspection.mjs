/** Private perception through the published native browser API. No caller can
 * supply JavaScript, profile, endpoint, selector, or an unowned target policy. */
export const NATIVE_BROWSER_ELEMENT_INSPECTION = `(element) => {
  if (!(element instanceof Element) || !element.isConnected) return { connected: false };
  const bounds = element.getBoundingClientRect();
  const field = ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(element.tagName) || element.isContentEditable;
  const bounded = (value, limit) => String(value || '').slice(0, limit);
  return { connected: true, tag: element.tagName, type: bounded(element.getAttribute('type'), 256),
    role: bounded(element.getAttribute('role'), 256), name: bounded(element.getAttribute('name'), 512),
    label: bounded(element.getAttribute('aria-label') || element.getAttribute('placeholder'), 1500),
    href: bounded(element.getAttribute('href'), 4096), text: field ? '' : bounded(element.innerText || element.textContent, 1500),
    disabled: !!element.disabled,
    credentialForm: !!element.closest('form')?.querySelector('input[type=password],input[autocomplete*=password],input[autocomplete^=cc-]'),
    url: location.href, documentIdentity: performance.timeOrigin,
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
}`;
const fail = () => Object.assign(new Error('The native browser reference could not be inspected safely.'), { code: 'NATIVE_BROWSER_INSPECTION_DENIED', status: 403 });
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const metadataKeys = ['connected', 'tag', 'type', 'role', 'name', 'label', 'href', 'text', 'disabled', 'credentialForm', 'url', 'documentIdentity', 'bounds'];
const limits = { tag: 128, type: 256, role: 256, name: 512, label: 1500, href: 4096, text: 1500, url: 8192 };

export function createNativeBrowserInspector({ rpc, assertCurrent, assertIsolation = () => {} } = {}) {
  if (typeof rpc !== 'function' || typeof assertCurrent !== 'function' || typeof assertIsolation !== 'function') throw new TypeError('Private native browser inspection requires a live invocation authority.');
  return async function inspectNativeTarget(params) {
    if (!plain(params) || Object.keys(params).length !== 2 || !Object.hasOwn(params, 'targetId') || !Object.hasOwn(params, 'ref') ||
        !/^[a-zA-Z0-9_-]{1,256}$/.test(params.targetId || '') || !/^[a-zA-Z0-9_-]{1,128}$/.test(params.ref || '')) throw fail();
    await assertCurrent(params);
    const result = await rpc('browser.request', { method: 'POST', path: '/act', target: 'host', query: { profile: 'chainchat-owned' },
      body: { kind: 'evaluate', targetId: params.targetId, ref: params.ref, fn: NATIVE_BROWSER_ELEMENT_INSPECTION, timeoutMs: 10000 }, timeoutMs: 12000 });
    await assertCurrent(params);
    const metadata = result?.result;
    if (result?.ok !== true || result.targetId !== params.targetId || !plain(metadata) ||
        Object.keys(metadata).length !== metadataKeys.length || metadataKeys.some(key => !Object.hasOwn(metadata, key)) || metadata.connected !== true ||
        Object.entries(limits).some(([key, limit]) => typeof metadata[key] !== 'string' || metadata[key].length > limit) ||
        !/^[A-Za-z][A-Za-z0-9:-]*$/.test(metadata.tag) || typeof metadata.disabled !== 'boolean' || typeof metadata.credentialForm !== 'boolean' ||
        !Number.isFinite(metadata.documentIdentity) || metadata.documentIdentity <= 0 || metadata.url !== result.url ||
        !plain(metadata.bounds) || Object.keys(metadata.bounds).length !== 4 || ['x', 'y', 'width', 'height'].some(key =>
          !Number.isFinite(metadata.bounds[key]) || Math.abs(metadata.bounds[key]) > 10000000) || metadata.bounds.width < 0 || metadata.bounds.height < 0) throw fail();
    await assertIsolation(metadata);
    return structuredClone(metadata);
  };
}
