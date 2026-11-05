const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const HOST_TOOLS = new Map([
  ['read', ['Read files', 'Read files inside the approved directories.']],
  ['write', ['Write files', 'Create or replace files inside the approved directories.']],
  ['edit', ['Edit files', 'Edit matching text inside the approved directories.']],
  ['web_fetch', ['Fetch web pages', 'Fetch from approved public hostnames.']],
  ['browser', ['Control the owned browser', 'Use a separate browser profile on approved public hostnames.']],
  ['exec', ['Run shell commands', 'Requires a separate grant to run commands under your operating-system account.']],
  ['process', ['Manage command sessions', 'Requires the separate execution grant for process controls.']],
  ['chainchat_automation', ['Manage agent services', 'Manage this agent’s reviewed schedules and channel bindings.']],
]);
const BROWSER_STATE = new Map([
  ['available', 'A supported browser is ready for the separate profile.'],
  ['installed', 'Managed Chromium is ready for the separate profile.'],
  ['installing', 'Managed Chromium setup is in progress.'],
  ['not-installed', 'Set up a browser in the Browser tab.'],
  ['failed', 'Browser setup needs attention in the Browser tab.'],
]);
const TOOL_OUTCOME = new Map([
  ['started', 'tool started'],
  ['completed', 'tool result received'],
  ['failed', 'tool reported failure'],
  ['held', 'tool result held'],
]);

export function hostToolChoices(snapshot) {
  const source = Array.isArray(snapshot?.toolCatalogue) ? snapshot.toolCatalogue : [];
  const grant = snapshot?.toolAuthority?.grant || {};
  const selected = new Set(Array.isArray(grant.tools) ? grant.tools : []);
  const seen = new Set();
  const browserState = snapshot?.browserRuntime?.state;
  return source.slice(0, 228).flatMap(entry => {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name) || seen.has(name)) return [];
    seen.add(name);
    const [label, description] = HOST_TOOLS.get(name) || [name, 'A tool supplied by an explicitly trusted native plugin.'];
    const available = snapshot?.runtime?.hostTools !== 'disabled' && (typeof entry === 'string' || entry.available === true);
    const browserSetup = name === 'browser' ? BROWSER_STATE.get(browserState) || 'Browser setup status is unavailable.' : '';
    const details = available ? [description, browserSetup].filter(Boolean).join(' ') : 'Unavailable in this local runtime.';
    return [{ name, label, details, available, selected: selected.has(name) }];
  });
}

export function chatToolAccess(snapshot, { connected, agentId, agentName, memoryPaused, runtimeReady, modelConfigured, chainHeld } = {}) {
  if (!connected) return { status: 'Connect the local app', detail: 'Tools start off. Connect your installed app to manage agent permissions.' };
  if (!agentId) return { status: 'Select a Timechain', detail: 'Tool permissions are saved separately for each agent.' };
  const grant = snapshot?.toolAuthority?.grant;
  if (!grant) return { status: 'Tool status unavailable', detail: 'Open Tool access to check saved permissions for this agent.' };

  const rows = hostToolChoices(snapshot);
  const hostOn = grant.enabled === true && grant.acknowledged === true;
  const native = grant.nativeCapabilities;
  const nativeCount = native?.enabled === true && native.acknowledged === true && Array.isArray(native.tools) ? native.tools.length : 0;
  const scoped = hostOn ? rows.filter(row => row.selected) : [];
  const savedCount = hostOn && Array.isArray(grant.tools) ? new Set(grant.tools).size : 0;
  const directoryCount = Array.isArray(grant.roots) ? grant.roots.length : 0;
  const hostCount = Array.isArray(grant.networkHosts) ? grant.networkHosts.length : 0;
  const shell = hostOn && grant.allowExecution === true && scoped.some(row => row.name === 'exec' || row.name === 'process');
  const browserReady = ['available', 'installed'].includes(snapshot?.browserRuntime?.state);
  const usable = scoped.filter(({name, available}) => available
    && (!['read', 'write', 'edit'].includes(name) || directoryCount > 0)
    && (!['web_fetch', 'browser'].includes(name) || hostCount > 0)
    && (name !== 'browser' || browserReady)
    && (!['exec', 'process'].includes(name) || shell));
  const agent = typeof agentName === 'string' && agentName.trim() ? agentName.slice(0, 120) : 'this agent';
  const detail = `Saved for ${agent}: ${savedCount} host tool grants, ${nativeCount} additional native tool grants, ${directoryCount} allowed directories, ${hostCount} allowed public hosts. Shell and process execution grant ${shell ? 'on' : 'off'}. Each proposed action still requires PoI and its native approvals.`;

  if (memoryPaused) return { status: 'Tools paused with memory', detail };
  if (chainHeld) return { status: 'Tools held for chain review', detail };
  if (!savedCount && !nativeCount) return { status: 'Tools off', detail };
  if (runtimeReady !== true) return { status: 'Grants saved · runtime unavailable', detail };
  if (modelConfigured === false) return { status: 'Grants saved · select a model', detail };
  if (usable.length < savedCount) return { status: 'Some tool grants need setup', detail };
  return { status: `${savedCount + nativeCount} tool grants saved`, detail };
}

export function chatToolActivity(activity, fresh) {
  if (!fresh || !Array.isArray(activity?.events)) return '';
  for (const event of activity.events.slice(-80).reverse()) {
    if (event.ability === 'operation' && event.status === 'started') break;
    if (typeof event.label !== 'string') continue;
    if (event.ability === 'tool') {
      const result = /^Tool ([A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}) (started|completed|failed|held)$/.exec(event.label);
      if (result && result[2] === event.status) return `${result[1]} · ${TOOL_OUTCOME.get(event.status)}`;
    }
    if (event.ability !== 'gate') continue;
    const review = /^PoI scopes and reviews the proposed ([a-z_]{1,64}) tool call$/.exec(event.label);
    if (review && event.status === 'started') return `${review[1]} · review requested`;
    const approved = /^PoI approved ([a-z_]{1,64}); native execution may now begin$/.exec(event.label);
    if (approved && event.status === 'completed') return `${approved[1]} · approved for execution`;
    const held = /^PoI withheld the proposed ([a-z_]{1,64}) tool call$/.exec(event.label);
    if (held && event.status === 'held') return `${held[1]} · held before execution`;
  }
  return '';
}
