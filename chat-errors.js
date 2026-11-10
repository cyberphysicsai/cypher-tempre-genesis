/** Public diagnostics contain fixed labels, never raw provider or transport data. */
const STAGES = Object.freeze({
  'memory-planning': 'Memory retrieval planning', generation: 'Model generation', review: 'Covenant review',
  'native-review': 'Native review', 'chain-preparation': 'Chain preparation', loadout: 'Faculty loadout',
  context: 'Context budget', compaction: 'Transcript compaction', commitment: 'Block commitment',
  provider: 'Provider connection', runtime: 'Local runtime', authorization: 'Authorization', cancellation: 'Cancellation',
});
const GROUPS = [
  { codes: ['EMERGENCY_HALTED'], stage: 'runtime', title: 'EMERGENCY HALT ACTIVE', kind: 'cancelled',
    message: 'ChainChat held this request. Open the installed app to verify and re-arm.', action: null },
  { codes: ['OPENCLAW_MEMORY_EXHAUSTED'], stage: 'runtime', title: 'LOCAL MEMORY EXHAUSTED', kind: 'runtime',
    message: 'The local runtime reported a memory-allocation failure. Free system memory and inspect its diagnostics before restarting. No unreviewed answer was released.', action: 'native' },
  { codes: ['OPENCLAW_PROCESS_KILLED'], stage: 'runtime', title: 'GATEWAY KILLED EXTERNALLY', kind: 'runtime',
    message: 'The gateway was killed with SIGKILL. Memory pressure is possible, but the signal alone does not confirm an out-of-memory kill. Inspect the operating system logs.', action: 'native' },
  { codes: ['OPENCLAW_PROCESS_EXITED'], stage: 'runtime', title: 'GATEWAY EXITED', kind: 'runtime',
    message: 'The gateway exited unexpectedly. Inspect runtime diagnostics; an exit code alone does not establish database corruption.', action: 'native' },
  { codes: ['OPENCLAW_START_FAILED', 'OPENCLAW_START_TIMEOUT'], stage: 'runtime', title: 'GATEWAY STARTUP FAILED', kind: 'runtime',
    message: 'The local gateway did not complete startup. Inspect runtime diagnostics and available memory. A failed start or timeout alone does not establish database corruption.', action: 'native' },
  { codes: ['COVENANT_REJECTED', 'POI_REJECTED', 'SPAN_GUARD', 'ALL_PERSPECTIVES_REJECTED'],
    stage: 'review', title: 'POI REVIEW HELD', kind: 'gate',
    message: 'PoI withheld the proposed response. Inspect the assessment and request a grounded revision.', action: null },
  { codes: ['GATE_INVALID_REVIEW', 'GATE_INVALID_EVIDENCE', 'GATE_INVALID_CONTEXT', 'GATE_INVALID_COVENANT', 'GATE_INVALID_AGENT_CONTEXT', 'REVIEW_INVALID'],
    stage: 'review', title: 'REVIEW COULD NOT COMPLETE', kind: 'review',
    message: 'The model did not return a complete valid review. No unreviewed answer was released. Check model limits and retry.', action: 'model' },
  { codes: ['PROVIDER_INCOMPLETE', 'PROVIDER_NO_TEXT', 'PROVIDER_EMPTY_RESPONSE', 'EMPTY_RESPONSE'], stage: 'generation', title: 'MODEL RESPONSE INCOMPLETE', kind: 'provider',
    message: 'The provider stopped before returning complete text. Check the model output limit and retry.', action: 'model' },
  { codes: ['PROVIDER_CONTEXT_LIMIT', 'OPENCLAW_CONTEXT_BUDGET', 'REQUEST_TOO_LARGE'], stage: 'context', title: 'CONTEXT LIMIT REACHED', kind: 'provider',
    message: 'The request does not fit the selected model context budget. Check its documented limits or shorten the input.', action: 'model' },
  { codes: ['OPENCLAW_OUTPUT_BUDGET'], stage: 'generation', title: 'OUTPUT LIMIT NEEDS ATTENTION', kind: 'provider',
    message: 'The model output budget could not be admitted. Check the output ceiling documented for this model.', action: 'model' },
  { codes: ['PROVIDER_CONTENT_HELD'], stage: 'provider', title: 'PROVIDER HELD RESPONSE', kind: 'provider',
    message: 'The provider held this response under its own policy. Review the request and selected model settings.', action: 'model' },
  { codes: ['PROVIDER_CREDENTIAL_REFLECTION'], stage: 'provider', title: 'PRIVATE RESPONSE WITHHELD', kind: 'provider',
    message: 'A response containing a private credential was withheld. Inspect the model connection before retrying.', action: 'model' },
  { codes: ['INVALID_REQUEST'], stage: 'generation', title: 'REQUEST NEEDS ATTENTION', kind: 'request',
    message: 'Check the input and selected settings, then retry.', action: null },
  { codes: ['PROVIDER_HTTP_ERROR', 'PROVIDER_RATE_LIMIT', 'PROVIDER_CONNECTION_ERROR', 'PROVIDER_TIMEOUT', 'PROVIDER_INVALID_RESPONSE', 'PROVIDER_TOOL_CALL', 'INVALID_PROVIDER', 'INVALID_PROVIDER_LIMITS'],
    stage: 'provider', title: 'PROVIDER REQUEST DID NOT COMPLETE', kind: 'provider',
    message: 'The provider could not complete this request. Check model access, limits and connection; retry after any rate limit clears.', action: 'model' },
  { codes: ['INVALID_LOADOUT', 'LOADOUT_INVALID', 'FACULTY_UNAVAILABLE'], stage: 'loadout', title: 'EQUIPMENT NEEDS ATTENTION', kind: 'equipment',
    message: 'Some equipped faculties are unavailable in this catalogue. Refresh the agent or explicitly clear equipment and choose available faculties.', action: 'loadout' },
  { codes: ['PENDING_HELD', 'PENDING_STALE'], stage: 'commitment', title: 'PENDING BLOCK NEEDS RECHECK', kind: 'pending',
    message: 'A pending block needs review against the current chain. Open Continuum and choose Commit pending block to recheck it.', action: 'continuum' },
  { codes: ['CHAIN_LOCKED', 'INTEGRITY_FAILED', 'CHAIN_INVALID', 'STALE_HEAD', 'REGISTRY_MISMATCH', 'MAINTENANCE_RECOVERY_REQUIRED'],
    stage: 'chain-preparation', title: 'CHAIN NEEDS INSPECTION', kind: 'chain',
    message: 'The native engine held this operation to protect chain integrity. Inspect the chain and its recovery status before retrying.', action: 'inspect' },
  { codes: ['OPENCLAW_COMPACTION_HELD'], stage: 'compaction', title: 'COMPACTION HELD', kind: 'review',
    message: 'The conversation summary was not accepted. Inspect the native context and compaction status before retrying.', action: 'native' },
  { codes: ['OPENCLAW_ENFORCEMENT', 'OPENCLAW_ENFORCEMENT_UNHEALTHY', 'OPENCLAW_NATIVE_HELD', 'OPENCLAW_CONTROL_CLOSED', 'OPENCLAW_CONTROL_TIMEOUT', 'OPENCLAW_CONTROL_AUTH', 'OPENCLAW_EMPTY_RESPONSE', 'OPENCLAW_ADMISSION_FAILED', 'OPENCLAW_REQUIRED', 'ENGINE_PROTOCOL', 'ENGINE_TIMEOUT', 'ENGINE_REJECTED', 'ENGINE_ERROR', 'PYTHON_UNAVAILABLE'],
    stage: 'runtime', title: 'ACTIVE RUNTIME HELD', kind: 'runtime',
    message: 'The local runtime could not return an approved answer. Inspect runtime status and use this code when reporting the failure.', action: 'native' },
  { codes: ['SESSION_CHANGED'], stage: 'authorization', title: 'MODEL SESSION CHANGED', kind: 'authorization',
    message: 'The model connection or local session changed while this request was running. Inspect the current connection, then retry.', action: 'model' },
  { codes: ['UNAUTHORIZED', 'PAIR_REQUIRED', 'PAIRING_REQUIRED', 'LOCAL_LAUNCH_REQUIRED', 'LOCAL_SESSION_EXPIRED'],
    stage: 'authorization', title: 'AUTHORIZATION NEEDS ATTENTION', kind: 'authorization',
    message: 'The local app session is unavailable or expired. Open ChainChat using its application launcher, or reconnect in optional website mode.', action: 'connect' },
  { codes: ['CANCELLED', 'REQUEST_CANCELLED'], stage: 'cancellation', title: 'REQUEST STOPPED', kind: 'cancelled',
    message: 'The operation was stopped. Refresh and inspect the latest chain receipt before retrying.', action: null },
];
const BY_CODE = new Map(GROUPS.flatMap(group => group.codes.map(code => [code, group])));
const ACTIONS = Object.freeze({ model: 'Open model settings', loadout: 'Review equipped faculties', continuum: 'Open pending block', inspect: 'Inspect chain', native: 'Open runtime settings', connect: 'Reconnect local app' });
const RUNTIME_CAUSES = new Set(['OPENCLAW_MEMORY_EXHAUSTED', 'OPENCLAW_PROCESS_KILLED',
  'OPENCLAW_PROCESS_EXITED', 'OPENCLAW_START_FAILED', 'OPENCLAW_START_TIMEOUT',
  'OPENCLAW_ENFORCEMENT_UNHEALTHY', 'OPENCLAW_CONTROL_CLOSED', 'OPENCLAW_CONTROL_TIMEOUT', 'OPENCLAW_CONTROL_AUTH']);

export function chatFailure(error = {}) {
  const suppliedCode = error?.name === 'AbortError' ? 'REQUEST_CANCELLED' : error?.code;
  const code = BY_CODE.has(suppliedCode) ? suppliedCode : 'REQUEST_FAILED';
  const group = BY_CODE.get(code) || { stage: 'runtime', title: 'REQUEST DID NOT COMPLETE', kind: 'runtime',
    message: 'The local app could not complete this request. Inspect its status and report the code and stage shown here.', action: 'native' };
  const stage = RUNTIME_CAUSES.has(code) ? 'runtime' : Object.hasOwn(STAGES, error?.stage) ? error.stage : group.stage;
  return { code, stage, stageLabel: STAGES[stage], title: group.title, kind: group.kind,
    message: group.message, action: group.action, actionLabel: ACTIONS[group.action] || null };
}

export function providerLimits(input = {}) {
  const result = {};
  for (const [key, label, min, max] of [['contextWindow', 'Context window', 4096, 2097152], ['maxOutputTokens', 'Output ceiling', 128, 32768]]) {
    const supplied = input[key];
    if (supplied === undefined || supplied === null || String(supplied).trim() === '') continue;
    const value = String(supplied).trim();
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max)
      throw Object.assign(new Error(`${label} must be a whole number between ${min.toLocaleString()} and ${max.toLocaleString()} tokens.`), { code: 'INVALID_PROVIDER_LIMITS' });
    result[key] = Number(value);
  }
  if (result.contextWindow && result.maxOutputTokens >= result.contextWindow)
    throw Object.assign(new Error('The output ceiling must be smaller than the context window.'), { code: 'INVALID_PROVIDER_LIMITS' });
  return result;
}

export function loadoutRepairNotice(repair) {
  if (repair?.reason !== 'unavailable-faculties' || !repair.removed) return '';
  const values = kind => Array.isArray(repair.removed[kind]) ? repair.removed[kind].slice(0, 12)
    .map(value => String(value)).map(value => /^(?:(?:modality|sense):)?\d{1,16}$/.test(value) ? value : '[unavailable ID]') : [];
  const modalities = values('modalities'), senses = values('senses');
  if (!modalities.length && !senses.length) return '';
  return `Equipment updated for this catalogue. Removed unavailable ${[
    modalities.length ? `modalities: ${modalities.join(', ')}` : '', senses.length ? `senses: ${senses.join(', ')}` : '',
  ].filter(Boolean).join('; ')}. Valid equipment was retained. Your historical chain was preserved.`;
}
