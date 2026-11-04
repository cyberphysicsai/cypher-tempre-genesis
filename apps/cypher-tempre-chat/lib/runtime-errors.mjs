// Public diagnostics are fixed metadata, never provider bodies or private prompts.
import { DIMENSIONS, FRUITS, REVIEW_THRESHOLD } from './providers.mjs';
const messages = Object.freeze({
  SESSION_CHANGED: 'The model or local session changed. Retry from the current app session.',
  PAIR_REQUIRED: 'This local session expired. Open ChainChat from its application launcher.',
  PROVIDER_HTTP_ERROR: 'The provider rejected the model request. Check the model, endpoint and configured limits.',
  PROVIDER_RATE_LIMIT: 'The provider rate limit or quota was reached. Wait before retrying.',
  PROVIDER_TIMEOUT: 'The provider did not complete the request in time.',
  PROVIDER_CONNECTION_ERROR: 'The provider connection failed. Check its endpoint and availability.',
  PROVIDER_INCOMPLETE: 'The model response was incomplete. Check the output limit and retry.',
  PROVIDER_NO_TEXT: 'The model did not return a complete text answer.',
  PROVIDER_CONTENT_HELD: 'The model provider held this response under its content policy.',
  PROVIDER_INVALID_RESPONSE: 'The provider returned an invalid or failed response. Check the model connection.',
  PROVIDER_TOOL_CALL: 'The model requested a tool for a text-only request. No action was executed.',
  PROVIDER_CREDENTIAL_REFLECTION: 'A response containing a private credential was withheld.',
  GATE_INVALID_REVIEW: 'The model did not return a complete valid review. No answer was released.',
  GATE_INVALID_EVIDENCE: 'The model review did not identify valid evidence. No answer was released.',
  GATE_INVALID_CONTEXT: 'The review context could not be validated. No answer was released.',
  GATE_INVALID_COVENANT: 'The verified genesis covenant could not be supplied to the reviewer.',
  GATE_INVALID_AGENT_CONTEXT: 'The verified agent context could not be supplied to the reviewer.',
  COVENANT_REJECTED: 'The response did not pass the covenant assessment. No answer was released.',
  POI_REJECTED: 'The native Proof of Interaction gate held this response.',
  STALE_HEAD: 'The Timechain changed during the request. Refresh before retrying.',
  INVALID_LOADOUT: 'The equipped faculties are unavailable. Refresh or clear the equipment.',
  CHAIN_LOCKED: 'The native Timechain is locked and requires local inspection.',
  PENDING_HELD: 'A pending exchange requires explicit review and commitment before another active turn.',
  OPENCLAW_CONTEXT_BUDGET: 'The active agent context exceeds the configured model context window. Increase the supported window or shorten the conversation.',
  OPENCLAW_OUTPUT_BUDGET: 'The model request has an invalid output budget.',
});
export const CHAT_STAGES = new Set(['memory-planning', 'generation', 'review', 'native-review',
  'chain-preparation', 'loadout', 'context', 'compaction', 'commitment', 'provider', 'runtime', 'authorization', 'cancellation']);
export function errorStage(error, fallback = 'runtime') {
  if (CHAT_STAGES.has(error?.stage)) return error.stage;
  const code = error?.code || '';
  if (/^(?:REQUEST_CANCELLED|CANCELLED)$/.test(code)) return 'cancellation';
  if (/^(?:SESSION_|PAIR_|PROVIDER_REQUIRED)/.test(code)) return 'authorization';
  if (code === 'INVALID_LOADOUT') return 'loadout';
  if (code === 'POI_REJECTED') return 'native-review';
  if (/^(?:GATE_|COVENANT_REJECTED)/.test(code)) return 'review';
  if (/^PROVIDER_|^INVALID_PROVIDER/.test(code)) return 'provider';
  if (/CONTEXT_BUDGET/.test(code)) return 'context';
  if (/COMPACTION/.test(code)) return 'compaction';
  return CHAT_STAGES.has(fallback) ? fallback : 'runtime';
}
export function safeInvocationError(error, fallbackStage = 'runtime') {
  if (!Object.hasOwn(messages, error?.code || '')) return null;
  const code = error.code;
  const status = code === 'SESSION_CHANGED' ? 409 : code === 'PAIR_REQUIRED' ? 401
    : code === 'PROVIDER_RATE_LIMIT' ? 429 : code === 'PROVIDER_TIMEOUT' ? 504
    : /^PROVIDER_(?:HTTP|CONNECTION)/.test(code) ? 502 : 422;
  const cleanScores = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    keys.every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 255)
    ? Object.fromEntries(keys.map(key => [key, value[key]])) : null;
  const scores = cleanScores(error.gate?.scores, DIMENSIONS), fruits = cleanScores(error.gate?.fruits, FRUITS);
  const gate = error.gate?.approved === false && ['COVENANT_REJECTED', 'POI_REJECTED'].includes(code)
    ? { approved: false, decision: 'REJECT', threshold: REVIEW_THRESHOLD,
      ...(scores ? { scores } : {}), ...(fruits ? { fruits } : {}) } : null;
  return { code, stage: errorStage(error, fallbackStage), message: messages[code], status, ...(gate ? { gate } : {}) };
}
export function invocationError(snapshot) {
  const safe = safeInvocationError(snapshot, snapshot?.stage);
  return safe ? Object.assign(new Error(safe.message), safe) : null;
}
