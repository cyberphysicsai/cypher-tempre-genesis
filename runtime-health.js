// Only fixed health metadata is displayed. App authentication is not runtime health.
const NATIVE_FAILURES = new Set(['OPENCLAW_ENFORCEMENT_UNHEALTHY', 'OPENCLAW_START_FAILED', 'OPENCLAW_START_TIMEOUT',
  'OPENCLAW_CONTROL_CLOSED', 'OPENCLAW_CONTROL_TIMEOUT', 'OPENCLAW_CONTROL_AUTH', 'OPENCLAW_VERSION_MISMATCH',
  'OPENCLAW_PROCESS_KILLED', 'OPENCLAW_PROCESS_EXITED', 'OPENCLAW_MEMORY_EXHAUSTED', 'OPENCLAW_RUNTIME']);
const ENGINE_FAILURES = new Set(['ENGINE_ERROR', 'ENGINE_PROTOCOL', 'ENGINE_TIMEOUT', 'PYTHON_UNAVAILABLE']);
const FAILURE_VIEWS = {
  OPENCLAW_MEMORY_EXHAUSTED: ['RUNTIME MEMORY EXHAUSTED', 'The local runtime reported a memory-allocation failure. Free system memory and inspect the local diagnostics before restarting. No model answer was released.'],
  OPENCLAW_PROCESS_KILLED: ['OPENCLAW PROCESS KILLED', 'The gateway was killed externally (SIGKILL). Memory pressure is one possible cause; this signal alone does not confirm an out-of-memory kill. Check the operating system logs.'],
  OPENCLAW_PROCESS_EXITED: ['OPENCLAW STOPPED', 'The gateway exited unexpectedly. Inspect the local runtime diagnostics before restarting. An exit code alone does not establish database corruption.'],
  OPENCLAW_ENFORCEMENT_UNHEALTHY: ['POI RUNTIME UNHEALTHY', 'The mandatory PoI runtime is unavailable. Requests stay held; inspect the runtime before restarting the app.'],
  OPENCLAW_START_TIMEOUT: ['OPENCLAW STARTUP TIMED OUT', 'The gateway did not complete startup. Check available memory and local startup diagnostics. A timeout alone does not establish database corruption.'],
  OPENCLAW_START_FAILED: ['OPENCLAW STARTUP FAILED', 'The local gateway could not start. Inspect the runtime diagnostics and available system memory.'],
  OPENCLAW_CONTROL_TIMEOUT: ['OPENCLAW CONTROL TIMED OUT', 'The private runtime control connection timed out. No unreviewed answer was released. Inspect the runtime before retrying.'],
  OPENCLAW_CONTROL_CLOSED: ['OPENCLAW CONTROL DISCONNECTED', 'The private runtime control connection closed. The browser session remains paired, but the agent is not ready.'],
};
const fixedFailure = code => FAILURE_VIEWS[code] || (ENGINE_FAILURES.has(code)
  ? ['AGENT ENGINE UNAVAILABLE', 'The local chain engine could not complete its work. Inspect the worker diagnostics; this failure alone does not establish database corruption.']
  : ['OPENCLAW NEEDS ATTENTION', 'The local runtime is not ready. Inspect its diagnostics before retrying.']);
const validNumber = value => Number.isSafeInteger(value) && value >= 0;

function projection(runtime) {
  if (!runtime || typeof runtime !== 'object') return null;
  return { backend: runtime.backend === 'openclaw' ? 'openclaw' : runtime.backend === 'direct' ? 'direct' : null,
    running: runtime.running === true, healthy: runtime.healthy === true, enforcementHealthy: runtime.enforcementHealthy === true,
    healthState: ['starting', 'stopping', 'stopped', 'ready', 'unhealthy'].includes(runtime.healthState) ? runtime.healthState : null,
    healthRevision: validNumber(runtime.healthRevision) ? runtime.healthRevision : null,
    generation: validNumber(runtime.generation) ? runtime.generation : null,
    failureCode: NATIVE_FAILURES.has(runtime.failureCode) ? runtime.failureCode : null };
}

export function createRuntimeHealthDisplay() {
  let revision = 0, runtime = null, fault = null, unreachable = false;
  return {
    get revision() { return revision; },
    reset() { revision++; runtime = null; fault = null; unreachable = false; },
    unavailable(expected = revision) {
      if (expected !== revision) return false;
      revision++; unreachable = true; return true;
    },
    failed(code, expected = revision) {
      if (expected !== revision || !NATIVE_FAILURES.has(code) && !ENGINE_FAILURES.has(code)) return false;
      revision++; runtime = null; unreachable = false; fault = code; return true;
    },
    observe(value, expected = revision, { agentVerified = false } = {}) {
      if (expected !== revision) return false;
      const next = projection(value);
      if (!next?.backend) return false;
      if (runtime && runtime.healthRevision !== null && next.healthRevision !== null && next.healthRevision < runtime.healthRevision) return false;
      runtime = next; unreachable = false;
      if (next.failureCode) fault = next.failureCode;
      else if (next.backend === 'openclaw' && next.healthy && next.enforcementHealthy && (!ENGINE_FAILURES.has(fault) || agentVerified)) fault = null;
      else if (next.backend === 'direct' && ENGINE_FAILURES.has(fault) && agentVerified) fault = null;
      revision++; return true;
    },
    view({ paired = false, local = false } = {}) {
      if (!paired) return { online: false, label: local ? 'OPEN INSTALLED CHAINCHAT' : 'INSTALL & LAUNCH CHAINCHAT', detail: '' };
      if (unreachable) return { online: false, label: 'LOCAL APP UNREACHABLE', detail: 'The browser cannot reach the local app. Its last connected state is no longer a health confirmation. Reopen the installed app and check available memory.' };
      if (fault) { const [label, detail] = fixedFailure(fault); return { online: false, label, detail, code: fault }; }
      if (runtime?.backend === 'direct') return { online: true, label: 'LOCAL APP CONNECTED', detail: '' };
      if (!runtime) return { online: false, label: 'CHECKING RUNTIME HEALTH', detail: '' };
      if (runtime.healthState === 'starting') return { online: false, label: 'OPENCLAW STARTING', detail: 'The local app is paired. The gateway is still completing startup and PoI admission.' };
      if (runtime.healthState === 'stopping') return { online: false, label: 'OPENCLAW STOPPING', detail: 'The owned gateway is stopping. Agent readiness will be checked again after it starts.' };
      if (!runtime.running) return { online: false, label: 'OPENCLAW STOPPED', detail: 'The local app is paired, but its gateway is not running. Inspect the runtime before restarting.' };
      if (!runtime.healthy || !runtime.enforcementHealthy) return { online: false, label: 'OPENCLAW HEALTH UNVERIFIED', detail: 'The gateway process is running, but current private-control and PoI readiness have not been confirmed.' };
      return { online: true, label: 'OPENCLAW READY', detail: '' };
    },
  };
}
