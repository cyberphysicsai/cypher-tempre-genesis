export const DEFAULT_AUDIT_BRIDGE = 'http://127.0.0.1:8788';

// The auditor may contact only a bridge on this machine, never a remote URL.
export function normalizeBridgeURL(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Enter a local bridge URL, such as http://127.0.0.1:8788.');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The bridge URL must use HTTP on localhost or 127.0.0.1, with no credentials, path, query, or fragment.');
  }
  return url.origin;
}
