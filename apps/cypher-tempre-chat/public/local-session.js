import { isLocalBridgePage } from './bridge-connection.js';

const KEY = 'cypher-tempre.local-resume.v1';
const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function clearLocalResume(storage) {
  try { storage?.removeItem(KEY); } catch {}
}
export function localTabStorage() {
  try { return window.sessionStorage; } catch { return null; }
}
function launchRequired() {
  return Object.assign(new Error('Open ChainChat from the Start menu to connect this local chat automatically.'), { code: 'LOCAL_LAUNCH_REQUIRED' });
}
export async function connectLocalSession({ origin, nonce = null, storage, request }) {
  if (!isLocalBridgePage(origin)) throw launchRequired();
  let ticket;
  try { ticket = storage?.getItem(KEY); } catch {}
  const launching = valid(nonce);
  if (!launching && !valid(ticket)) throw launchRequired();
  let result;
  try {
    result = await request(launching ? '/api/launch' : '/api/local-resume',
      launching ? { nonce } : { resumeTicket: ticket });
  } catch (error) {
    clearLocalResume(storage);
    throw error;
  }
  if (!valid(result?.token) || !valid(result?.resumeTicket)) {
    clearLocalResume(storage);
    throw launchRequired();
  }
  let resumable = false;
  try { storage?.setItem(KEY, result.resumeTicket); resumable = !!storage; } catch {}
  // Only the opaque rotating resume credential is stored. Provider API keys
  // and the API bearer token are never written to browser storage.
  return { token: result.token, resumable };
}
