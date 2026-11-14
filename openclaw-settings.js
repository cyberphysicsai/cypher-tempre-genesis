import { chatToolAccess, chatToolActivity, hostToolChoices } from './chat-tools.js';
import { mountNativeConfigForm } from './native-config-form.js';
import { mountNativeChannelSetup } from './native-channel-setup.js';

export function nativeBlockedConfigGuards(next={}) {
  const config=next.config || {},grant=next.toolAuthority?.grant || {},native=grant.nativeCapabilities || {};
  const inside=(path,prefix)=>path===prefix||path.startsWith(prefix+'.');
  const admitted=path=>native.enabled===true&&native.acknowledged===true&&(native.settings||[]).some(prefix=>prefix==='*'||inside(path,prefix));
  const reason=path=>Object.entries(config.guards||{}).filter(([prefix])=>inside(path,prefix)).sort((a,b)=>b[0].length-a[0].length)[0]?.[1] || 'Managed by the local supervisor.';
  const blocked=Object.fromEntries((config.immutablePaths||[]).map(path=>[path,reason(path)]));
  for(const [path,note] of Object.entries(config.guards||{})) {
    if(admitted(path)||(['tools','browser'].includes(path)&&grant.enabled===true&&grant.acknowledged===true))continue;
    blocked[path]=note;
  }
  return blocked;
}
export function nativeConfigGuardFor(next={},parts=[],{includeChildren=false}={}) {
  const path=parts.join('.'),config=next.config||{},grant=next.toolAuthority?.grant||{},native=grant.nativeCapabilities||{};
  const inside=(field,prefix)=>field===prefix||field.startsWith(prefix+'.');
  const admitted=field=>native.enabled===true&&native.acknowledged===true&&(native.settings||[]).some(prefix=>prefix==='*'||inside(field,prefix));
  const media=['agents.defaults.imageModel','agents.defaults.voiceModel','agents.defaults.pdfModel','agents.defaults.mediaModels'];
  const nativeMedia=config.nativeProvider===true&&media.some(prefix=>inside(path,prefix))&&admitted(path);
  const immutable=config.immutablePaths||[];
  const fixed=immutable.find(prefix=>!nativeMedia&&(inside(path,prefix)||(includeChildren&&inside(prefix,path))));
  const guards=config.guards||{};
  if(fixed)return guards[fixed]||Object.entries(guards).filter(([prefix])=>inside(fixed,prefix)).sort((a,b)=>b[0].length-a[0].length)[0]?.[1]||'Managed by the local supervisor.';
  if(/^plugins\.entries\.[^.]+\.(?:enabled|env)(?:\.|$)/.test(path))return 'Use the reviewed native plugin controls.';
  const blocked=Object.entries(guards).find(([prefix])=>(inside(path,prefix)||(includeChildren&&inside(prefix,path)))&&!admitted(inside(path,prefix)?path:prefix)&&
    !(['tools','browser'].includes(prefix)&&grant.enabled===true&&grant.acknowledged===true));
  if(blocked)return blocked[1];
  if(!['messages','session','ui','logging','agents','memory'].includes(parts[0])&&!admitted(path)&&
    !(grant.enabled===true&&grant.acknowledged===true&&['tools','browser'].includes(parts[0])))return 'Allow this native setting path under Tool access before applying it.';
  return '';
}

const pretty = value => JSON.stringify(value ?? null, null, 2);
const nativeUtilityModelNotice = 'Automatic native metadata utilities are off by default. Explicitly configuring agents.defaults.utilityModel requires a native-settings owner grant and uses that model’s own native provider credentials, billing and privacy terms. These metadata-only calls have no action tools. Agent answers and actions retain canonical PoI review.';
const nativeQueuePolicyNotice = 'ChainChat frontend messages use followup: each request keeps its own identity and PoI review, with commitment following the selected Timechain block policy. Native /queue preferences apply to other native events and channel inputs; frontend requests stay separate.';
export function nativeCommandDescription(item = {}) {
  const original = `${String(item.description || '')}${item.mode ? ` · ${item.mode}` : ''}`;
  return String(item.name || '').trim().split(/\s/)[0].replace(/^\//, '') === 'queue'
    ? `${nativeQueuePolicyNotice} ${original}` : original;
}
export function buildAutomationSchedule({ kind, at, minutes, expr, tz }, now = Date.now()) {
  if (kind === 'at') {
    const timestamp = new Date(at).getTime();
    if (!Number.isFinite(timestamp) || timestamp <= now || timestamp > now + 365 * 86400000) throw new Error('Choose a future local time within the next year.');
    return { kind: 'at', at: new Date(timestamp).toISOString() };
  }
  if (kind === 'every') {
    const count = Number(minutes);
    if (!Number.isSafeInteger(count) || count < 1 || count > 525600) throw new Error('Choose a whole interval from 1 to 525600 minutes.');
    return { kind: 'every', everyMs: count * 60000 };
  }
  if (kind === 'cron') {
    if (typeof expr !== 'string' || expr.trim().split(/\s+/).length !== 5) throw new Error('Use a five-field cron expression.');
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new Error('Choose a valid IANA time zone.'); }
    return { kind: 'cron', expr: expr.trim(), tz };
  }
  throw new Error('Choose a schedule type.');
}
export function schemaFields(schema, query = '', family = '') {
  const result = [], filter = query.trim().toLowerCase();
  function walk(node, prefix = '', depth = 0) {
    if (!node || typeof node !== 'object' || depth > 15 || result.length > 500) return;
    for (const [key, child] of Object.entries(node.properties || {})) {
      const name = prefix ? `${prefix}.${key}` : key;
      const original = String(child.description || child.title || '');
      const description = name === 'agents.defaults.utilityModel' ? `${nativeUtilityModelNotice} ${original}` :
        name === 'messages.queue' || name.startsWith('messages.queue.') ? `${nativeQueuePolicyNotice} ${original}` : original;
      if (!filter || `${name} ${description}`.toLowerCase().includes(filter)) result.push({ name, description: description.slice(0, 1500), type: child.type || (child.properties ? 'object' : '') });
      walk(child, name, depth + 1);
    }
  }
  const root = schema?.schema || schema;
  walk(family && root?.properties?.[family] ? { properties: { [family]: root.properties[family] } } : root);
  return result.slice(0, 500);
}
export function schemaFamilies(schema, guards = {}, sections = []) {
  const root = schema?.schema || schema;
  return Object.keys(root?.properties || {}).slice(0, 500).sort().map(name => {
    const metadata = Array.isArray(sections) ? sections.find(item => item.key === name) : null;
    const classification = ['editable', 'owner-admitted', 'managed', 'supervisor-owned'].includes(metadata?.classification)
      ? metadata.classification : Object.hasOwn(guards, name) ? 'managed' : 'reference';
    return {
    name,
    description: String(root.properties[name]?.description || root.properties[name]?.title || '').slice(0, 1500),
    classification, reason: String(metadata?.reason || '').slice(0, 2000),
    protected: ['managed', 'supervisor-owned'].includes(classification),
    guards: Object.entries(guards).filter(([path]) => path === name || path.startsWith(name + '.'))
      .map(([path, reason]) => ({ path, reason: String(reason).slice(0, 2000) })),
  }; });
}
export function contextPolicyText(policy) {
  if (policy?.mode === 'reviewed-native-compaction' && policy?.automaticSummary === true && policy?.storedHistory === 'preserved')
    return 'Timechain recall retrieves relevant verified history. When model context pressure requires a summary, native compaction reviews its exact source and proposed summary through PoI before saving. Saved history stays preserved, and two recent complete turns remain in view. Each model still has a bounded context window.';
  if (policy?.mode === 'timechain-retrieval' && policy?.automaticSummary === false && policy?.storedHistory === 'preserved')
    return 'Retrieve relevant history for each request and keep the full saved conversation. Automatic summary compaction is off. Each model still has a bounded context window; oversized requests are held rather than silently discarding history.';
  return 'This runtime has not reported a recognized context policy. Inspect its runtime version before relying on a particular retrieval or summary mode. Each model context window remains bounded.';
}
const scopedNativeTools = new Set(['read', 'write', 'edit', 'web_fetch', 'browser', 'exec', 'process', 'chainchat_automation', 'get_goal', 'update_goal']);
const validNativeName = value => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export function nativeCapabilityCatalogue(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).slice(0, 2048).filter(row => row?.source === 'native' && validNativeName(row.name) && !seen.has(row.name) && seen.add(row.name))
    .map(row => ({ name: row.name, source: 'native', description: typeof row.description === 'string' ? row.description.slice(0, 1500) : '',
      available: row.available === true, scopedHostTool: row.scopedHostTool === true || scopedNativeTools.has(row.name) }));
}
export function nativeCapabilityPayload({ enabled, acknowledged, tools, settingsText = '', allSettings, delegatedRuns, backgroundRuns }, catalogue) {
  const known = new Set(nativeCapabilityCatalogue(catalogue).filter(row => row.available && !row.scopedHostTool).map(row => row.name));
  if (!Array.isArray(tools) || tools.length > 128 || new Set(tools).size !== tools.length || tools.some(name => !known.has(name)))
    throw new Error('Choose available discovered native tools; scoped host tools keep their separate permissions.');
  const settings = allSettings === true ? ['*'] : settingsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (settings.length > 256 || new Set(settings).size !== settings.length || settings.some(path => path.length > 256 ||
      path !== '*' && (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path) || path.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)))))
    throw new Error('Use unique exact native setting paths, one per line.');
  if (!allSettings && settings.includes('*')) throw new Error('Use the explicit all-native-settings checkbox to grant *.');
  if (enabled === true && acknowledged !== true) throw new Error('Acknowledge the OpenClaw host privileges before enabling native capabilities.');
  return { enabled: enabled === true, acknowledged: acknowledged === true, tools: [...tools], settings,
    delegatedRuns: delegatedRuns === true, backgroundRuns: backgroundRuns === true };
}
export function mountNativeCapabilityCard({ document: doc, mount, api, onSaved = async () => {}, onError = () => {}, context = () => '' }) {
  const make = (tag, text = '', className = '') => {
    const node = doc.createElement(tag); node.textContent = text; if (className) node.className = className; return node;
  };
  const form = make('form', '', 'native-card native-capability-card'); form.id = 'nativeCapabilityForm';
  form.append(make('h2', 'Additional native OpenClaw capabilities'), make('p',
    "Native tools run with OpenClaw's host privileges. This is not an OS or filesystem sandbox. Scoped file, browser, execution and goal tools keep their separate controls above. PoI, credentials and private transport stay protected."));
  const status = make('p', '', 'native-capability-status'); status.id = 'nativeCapabilityStatus'; status.setAttribute('role', 'status');
  const controls = make('fieldset', '', 'native-capability-controls'); controls.append(make('legend', 'Native owner grant', 'sr-only'));
  function check(id, text) {
    const label = make('label', '', 'native-check'), input = make('input'); input.type = 'checkbox'; input.id = id;
    label.append(input, make('span', text)); controls.append(label); return input;
  }
  const enabled = check('nativeCapabilitiesEnabled', 'Enable selected additional native capabilities for this agent');
  const tools = make('div', '', 'native-capability-tools'); tools.id = 'nativeAdditionalToolChoices'; controls.append(tools);
  const pathLabel = make('label', 'Native setting paths · one exact path per line', 'field'), paths = make('textarea');
  paths.id = 'nativeSettingPaths'; paths.rows = 3; paths.placeholder = 'agents.defaults.timeoutSeconds'; paths.spellcheck = false; pathLabel.append(paths); controls.append(pathLabel);
  const allSettings = check('nativeAllSettings', 'Allow all native setting paths (*) except operator-protected core paths');
  controls.append(make('p', 'These paths admit schema-validated settings edits; they cannot disable PoI, expose credentials, replace private transport or change the managed model route. The Settings tab lists the protected paths and reasons.', 'fine-print'));
  const delegated = check('nativeDelegatedRuns', 'Permit delegated runs when an inherited PoI binding is available');
  const background = check('nativeBackgroundRuns', 'Permit background runs when a registered PoI binding is available');
  controls.append(make('p', 'These are owner permissions, not execution indicators. A selected tool still needs current runtime admission, concrete action review and any required delegated or background binding.', 'fine-print'));
  const acknowledged = check('nativeCapabilitiesAcknowledged', 'I authorize these additional native capabilities with OpenClaw host privileges and understand that they are not sandboxed.');
  const actions = make('div', '', 'native-actions'), save = make('button', 'Apply native capability grant', 'primary-button'); save.type = 'submit'; save.id = 'saveNativeCapabilities';
  const revoke = make('button', 'Revoke additional native capabilities', 'secondary-button'); revoke.type = 'button'; revoke.id = 'revokeNativeCapabilities';
  actions.append(save, revoke); form.append(status, controls, actions); mount.append(form);
  let catalogue = [], last = null, ready = false, busy = false, epoch = 0;
  const choices = new Map();
  const availability = () => { controls.disabled = !ready || busy; save.disabled = !ready || busy; revoke.disabled = !ready || busy; paths.disabled = allSettings.checked; };
  function render(next) {
    last = next;
    ready = !!(next?.sessionKey || next?.selectedAgentId) && Array.isArray(next?.nativeToolCatalogue);
    catalogue = nativeCapabilityCatalogue(next?.nativeToolCatalogue); choices.clear(); tools.replaceChildren();
    const grant = next?.toolAuthority?.grant?.nativeCapabilities || {};
    enabled.checked = grant.enabled === true; acknowledged.checked = false;
    allSettings.checked = Array.isArray(grant.settings) && grant.settings.includes('*');
    paths.value = (Array.isArray(grant.settings) ? grant.settings : []).filter(path => typeof path === 'string' && path !== '*').join('\n');
    delegated.checked = grant.delegatedRuns === true; background.checked = grant.backgroundRuns === true;
    for (const row of catalogue) {
      const label = make('label', '', 'native-check native-capability-choice'), input = make('input'); input.type = 'checkbox';
      input.dataset.nativeExtraTool = row.name; input.checked = (grant.tools || []).includes(row.name);
      input.disabled = !row.available || row.scopedHostTool; choices.set(row.name, input);
      const copy = make('span'); copy.append(make('strong', row.name), make('small', row.scopedHostTool ? 'Separate scoped host-tool controls' : !row.available ? 'Not available in this runtime' : row.description || 'Discovered native tool'));
      label.append(input, copy); tools.append(label);
    }
    if (!catalogue.length) tools.append(make('p', ready ? 'No additional native tools are currently discovered. Native settings admission remains available.' : 'Select a local agent in a runtime that advertises native capabilities.', 'fine-print'));
    status.textContent = !ready ? 'Connect a selected agent to inspect its native capability catalogue.' : grant.enabled === true
      ? 'Owner grant saved · every call still requires PoI and current runtime admission.' : 'Additional native capabilities are disabled. Scoped host-tool permissions remain separate.';
    availability();
  }
  function reset() { epoch++; busy = false; render(null); }
  async function apply(revoking = false) {
    if (!ready || busy) return;
    let payload;
    try { payload = revoking ? { enabled: false, acknowledged: false, tools: [], settings: [], delegatedRuns: false, backgroundRuns: false }
      : nativeCapabilityPayload({ enabled: enabled.checked, acknowledged: acknowledged.checked,
        tools: [...choices].filter(([, input]) => input.checked && !input.disabled).map(([name]) => name), settingsText: paths.value,
        allSettings: allSettings.checked, delegatedRuns: delegated.checked, backgroundRuns: background.checked }, catalogue); }
    catch (failure) { onError(failure.message); return; }
    const owner = context(), version = epoch; busy = true; availability(); onError('');
    try {
      const result = await api('/api/openclaw/native-capabilities', payload);
      if (version !== epoch || owner !== context()) return;
      render({ ...last, toolAuthority: result.toolAuthority, nativeToolCatalogue: result.catalogue });
      status.textContent = revoking ? 'Additional native capabilities revoked. The local app requested cancellation of active calls.' : 'Native capability grant saved. Each action still requires fresh PoI and runtime admission.';
      await onSaved();
    } catch (failure) { if (version === epoch && owner === context()) onError(failure.message); }
    finally { if (version === epoch && owner === context()) { busy = false; availability(); } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); return apply(); });
  revoke.addEventListener('click', () => apply(true)); allSettings.addEventListener('change', availability);
  render(null);
  return { render, reset };
}

const nativeSourceAgent = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const nativeSourceOpaque = (value, limit = 128) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f\u2028\u2029]/.test(value);
const nativeSourceLabel = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) : '';
function nativeSourceRow(value) {
  if (!nativeSourceAgent(value?.agentId)) return null;
  if (value.kind === 'channel' && nativeSourceOpaque(value.channelId) && nativeSourceOpaque(value.accountId))
    return { kind: 'channel', agentId: value.agentId, channelId: value.channelId, accountId: value.accountId };
  if (value.kind === 'heartbeat') return { kind: 'heartbeat', agentId: value.agentId };
  if (value.kind === 'background' && nativeSourceOpaque(value.nativeSessionKey, 2048) && value.nativeSessionKey.startsWith(`agent:${value.agentId}:`))
    return { kind: 'background', agentId: value.agentId, nativeSessionKey: value.nativeSessionKey };
  return null;
}
export function nativeSourceView(value) {
  const agents = new Map(), sources = new Map(), channels = new Map(), sessions = new Map();
  for (const row of (Array.isArray(value?.available?.agents) ? value.available.agents : []).slice(0, 1024)) {
    if (nativeSourceAgent(row?.id)) agents.set(row.id, { id: row.id, name: nativeSourceLabel(row.name) || row.id, heartbeat: row.heartbeat === true });
  }
  for (const row of (Array.isArray(value?.available?.channels) ? value.available.channels : []).slice(0, 1024)) {
    if (!nativeSourceOpaque(row?.channelId) || !nativeSourceOpaque(row.accountId)) continue;
    const key = JSON.stringify([row.channelId, row.accountId]);
    channels.set(key, { channelId: row.channelId, accountId: row.accountId });
  }
  for (const row of (Array.isArray(value?.available?.sessions) ? value.available.sessions : []).slice(0, 1024)) {
    if (!nativeSourceAgent(row?.agentId) || !nativeSourceOpaque(row.key, 2048) || !row.key.startsWith(`agent:${row.agentId}:`)) continue;
    sessions.set(row.key, { agentId: row.agentId, key: row.key, label: nativeSourceLabel(row.label) || row.key });
  }
  for (const row of (Array.isArray(value?.sources) ? value.sources : []).slice(0, 1024)) {
    const source = nativeSourceRow(row);
    if (source && typeof row.id === 'string' && /^[a-f0-9]{64}$/.test(row.id)) sources.set(row.id, { id: row.id, ...source });
  }
  return { agents: [...agents.values()], channels: [...channels.values()], sessions: [...sessions.values()], sources: [...sources.values()] };
}
export function nativeSourceEnrollment(source, available) {
  const selected = nativeSourceRow(source), view = nativeSourceView({ available });
  if (!selected || !view.agents.some(row => row.id === selected.agentId)) throw new Error('Choose a configured native agent from the refreshed list.');
  if (selected.kind === 'channel' && !view.channels.some(row => row.channelId === selected.channelId && row.accountId === selected.accountId) ||
      selected.kind === 'heartbeat' && !view.agents.some(row => row.id === selected.agentId && row.heartbeat) ||
      selected.kind === 'background' && !view.sessions.some(row => row.key === selected.nativeSessionKey && row.agentId === selected.agentId))
    throw new Error('Choose a configured native source from the refreshed list.');
  return { action: 'enroll', source: selected };
}
export function nativeHeartbeatScratch(value, source) {
  if (source?.kind !== 'heartbeat' || value?.sourceId !== source.id || value.agentId !== source.agentId ||
      !Number.isSafeInteger(value.currentRevision) || value.currentRevision < 0 || !Number.isSafeInteger(value.maxBytes) ||
      value.maxBytes < 1 || value.maxBytes > 262144 || value.content !== null && (typeof value.content !== 'string' ||
      new TextEncoder().encode(value.content).length > value.maxBytes || value.content.includes('\0')))
    throw new Error('The native heartbeat notes do not match the selected enrolled source.');
  return {sourceId: source.id, agentId: source.agentId, content: value.content, currentRevision: value.currentRevision, maxBytes: value.maxBytes};
}
export function mountNativeSourceCard({ document: doc, mount, api, context = () => '' }) {
  const make = (tag, content = '', className = '') => { const node = doc.createElement(tag); node.textContent = content; node.className = className; return node; };
  const card = make('section', '', 'native-card native-source-card'); card.id = 'nativeSourceCard';
  card.append(make('h2', 'Native run source enrollment'), make('p', 'Bind an existing native source to the selected Timechain. Enrollment does not start it or grant extra tools. Each independent run still needs current owner authority, a verified chain and fresh PoI review. Native tools retain OpenClaw host privileges.'));
  card.append(make('p', 'Native API credentials and explicit background grants can admit enrolled sources while this browser is disconnected. Direct API tasks require a live provider session. Pausing parent memory, disabling background permission or revoking enrollment stops new admission. Native API keys stay in local OpenClaw when the browser disconnects.', 'fine-print'));
  const status = make('p', '', 'native-capability-status'); status.id = 'nativeSourcesStatus'; status.setAttribute('role', 'status');
  const refresh = make('button', 'Refresh configured native sources', 'secondary-button'); refresh.type = 'button'; refresh.id = 'refreshNativeSources';
  const form = make('form'), fields = make('fieldset', '', 'native-capability-controls'); form.id = 'nativeSourceForm';
  fields.append(make('legend', 'Enroll a verified native source', 'sr-only'));
  function select(id, label) { const holder = make('label', label, 'field'), input = make('select'); input.id = id; holder.append(input); fields.append(holder); return { holder, input }; }
  const kind = select('nativeSourceKind', 'Source kind'), agent = select('nativeSourceAgent', 'Configured native agent'), target = select('nativeSourceTarget', 'Configured source');
  for (const [value, label] of [['channel', 'Channel account'], ['heartbeat', 'Heartbeat'], ['background', 'Existing background session']]) {
    const option = make('option', label); option.value = value; kind.input.append(option);
  }
  kind.input.value = 'channel';
  const explanation = make('p', '', 'fine-print'); fields.append(explanation);
  const consentLabel = make('label', '', 'native-check'), consent = make('input'); consent.type = 'checkbox'; consent.id = 'nativeSourceAcknowledged';
  consentLabel.append(consent, make('span', 'Bind this configured source to the selected Timechain for independently reviewed native runs.')); fields.append(consentLabel);
  const enroll = make('button', 'Enroll selected native source', 'primary-button'); enroll.type = 'submit'; enroll.id = 'enrollNativeSource';
  form.append(fields, enroll);
  const list = make('div', '', 'native-service-list'); list.id = 'nativeEnrolledSources'; list.setAttribute('aria-label', 'Enrolled native run sources');
  const scratch = make('section', '', 'native-heartbeat-scratch'); scratch.id = 'nativeHeartbeatScratch'; scratch.hidden = true;
  const scratchTitle = make('h3', 'Heartbeat monitor notes'), scratchStatus = make('p', '', 'native-capability-status'); scratchStatus.id = 'nativeHeartbeatScratchStatus'; scratchStatus.setAttribute('role', 'status');
  const scratchForm = make('form'); scratchForm.id = 'nativeHeartbeatScratchForm';
  const scratchLabel = make('label', 'Owner monitor notes', 'field'), scratchNotes = make('textarea'); scratchNotes.id = 'nativeHeartbeatScratchNotes'; scratchNotes.rows = 6; scratchNotes.maxLength = 262144; scratchNotes.spellcheck = false; scratchLabel.append(scratchNotes);
  const scratchActions = make('div', '', 'native-actions');
  const scratchSave = make('button', 'Save monitor notes', 'primary-button'); scratchSave.id = 'saveNativeHeartbeatScratch'; scratchSave.type = 'submit';
  const scratchRefresh = make('button', 'Reload notes', 'secondary-button'); scratchRefresh.id = 'refreshNativeHeartbeatScratch'; scratchRefresh.type = 'button';
  const scratchConfigured = make('button', 'Use configured prompt', 'secondary-button'); scratchConfigured.id = 'resetNativeHeartbeatScratch'; scratchConfigured.type = 'button';
  const scratchClose = make('button', 'Close notes', 'text-button'); scratchClose.type = 'button'; scratchClose.id = 'closeNativeHeartbeatScratch';
  scratchActions.append(scratchSave, scratchRefresh, scratchConfigured, scratchClose); scratchForm.append(scratchLabel, scratchActions);
  scratch.append(scratchTitle, make('p', 'A heartbeat needs monitor notes or a configured prompt to perform scheduled model work. Saving empty notes skips that work. Use configured prompt removes this note override. Notes grant no tools; each scheduled agent turn still needs current enrollment, an owner background grant and PoI review.', 'fine-print'), scratchStatus, scratchForm);
  card.append(status, refresh, form, make('h3', 'Enrolled sources'), list, scratch); mount.append(card);
  let view = nativeSourceView(null), ready = false, permitted = false, busy = false, loaded = false, epoch = 0, owner = context();
  let scratchSource = null, scratchRevision = null, scratchMaxBytes = 262144;
  function options(input, entries, placeholder, selected = input.value) {
    input.replaceChildren(); const blank = make('option', placeholder); blank.value = ''; input.append(blank);
    for (const row of entries) { const option = make('option', row.label); option.value = row.value; input.append(option); }
    input.value = entries.some(row => row.value === selected) ? selected : '';
  }
  function candidates() {
    if (kind.input.value === 'channel') return view.channels.map((row, index) => ({ value: String(index), label: `${row.channelId} / ${row.accountId}`, row }));
    if (kind.input.value === 'background') return view.sessions.filter(row => row.agentId === agent.input.value).map(row => ({ value: row.key, label: row.label, row }));
    return [];
  }
  function selection() {
    const value = { kind: kind.input.value, agentId: agent.input.value }, chosen = candidates().find(row => row.value === target.input.value)?.row;
    if (value.kind === 'channel' && chosen) Object.assign(value, { channelId: chosen.channelId, accountId: chosen.accountId });
    if (value.kind === 'background' && chosen) value.nativeSessionKey = chosen.key;
    return value;
  }
  function availability() {
    refresh.disabled = !ready || busy; fields.disabled = !ready || !loaded || !permitted || busy;
    let valid = false; try { nativeSourceEnrollment(selection(), view); valid = true; } catch { /* Only discovered selections can be submitted. */ }
    enroll.disabled = fields.disabled || !consent.checked || !valid;
    for (const row of list.children) for (const button of row.children) if (button.tagName?.toLowerCase() === 'button') button.disabled = !ready || busy;
    scratchNotes.disabled = !ready || busy || scratchRevision === null; scratchNotes.readOnly = !permitted;
    scratchSave.disabled = !ready || !permitted || busy || scratchRevision === null;
    scratchConfigured.disabled = scratchSave.disabled; scratchRefresh.disabled = !ready || busy || !scratchSource; scratchClose.disabled = busy;
  }
  function targets() {
    options(target.input, candidates(), kind.input.value === 'channel' ? 'Choose a configured channel account' : 'Choose an existing native session');
    target.holder.hidden = kind.input.value === 'heartbeat';
    const eligible = view.agents.find(row => row.id === agent.input.value)?.heartbeat === true;
    explanation.textContent = !permitted ? 'To enroll a source, first apply an acknowledged additional native capability grant with background runs enabled. Existing enrollments can still be inspected and revoked.'
      : kind.input.value === 'heartbeat' ? eligible ? 'The selected native agent has a configured heartbeat. Enrollment does not start or reschedule it.' : 'Select an agent with a configured heartbeat; configure it in native settings first if none is listed.'
      : kind.input.value === 'channel' ? 'Select an existing enabled native channel account. This enrollment does not configure channel credentials or start a connection.'
      : 'Only existing native sessions for the selected agent appear. Enrollment does not create a session or inherit another agent’s tools.';
    availability();
  }
  function renderList() {
    list.replaceChildren();
    if (!view.sources.length) list.append(make('p', loaded ? 'No native run sources are enrolled for this Timechain.' : 'Refresh to inspect this Timechain’s enrolled sources.', 'fine-print'));
    for (const source of view.sources) {
      const row = make('article', '', 'native-service-row'); row.append(make('h4', `${source.kind} · ${source.agentId}`));
      row.append(make('p', source.kind === 'channel' ? `${source.channelId} / ${source.accountId}` : source.kind === 'background' ? source.nativeSessionKey : 'Configured native heartbeat'));
      row.append(make('p', 'Enrolled binding · execution and every action remain independently reviewed.', 'fine-print'));
      const revoke = make('button', 'Revoke this source enrollment', 'text-button'); revoke.type = 'button'; revoke.dataset.nativeSourceId = source.id;
      revoke.addEventListener('click', () => request({ action: 'revoke', id: source.id }, 'Source enrollment revoked. This does not stop or erase its native session.'));
      row.append(revoke); list.append(row);
      if (source.kind === 'heartbeat') {
        const edit = make('button', 'Edit heartbeat monitor notes', 'text-button'); edit.type = 'button'; edit.dataset.nativeScratchSource = source.id;
        edit.addEventListener('click', () => openScratch(source)); row.append(edit);
      }
    }
  }
  function accept(result) {
    const available = result?.available ? result.available : { agents: view.agents, channels: view.channels, sessions: view.sessions };
    view = nativeSourceView({ sources: result?.sources, available }); loaded = true;
    if (scratchSource && !view.sources.some(source => source.id === scratchSource.id && source.kind === 'heartbeat')) closeScratch();
    options(agent.input, view.agents.map(row => ({ value: row.id, label: `${row.name}${row.heartbeat ? ' · heartbeat configured' : ''}` })), 'Choose a configured native agent');
    consent.checked = false; renderList(); targets();
  }
  async function request(payload, success) {
    if (!ready || busy) return; const bound = context(), version = epoch; busy = true; availability();
    status.textContent = payload.action === 'list' ? 'Loading configured native sources…' : 'Applying the selected source binding…';
    try {
      const result = await api('/api/openclaw/sources', payload);
      if (version !== epoch || bound !== context()) return;
      accept(result); status.textContent = success || `${view.sources.length} enrolled source${view.sources.length === 1 ? '' : 's'} · configure native sources before enrollment when none are listed.`;
    } catch (failure) {
      if (version === epoch && bound === context()) {
        const codes = new Set(['OPENCLAW_NATIVE_BINDING_REQUIRED', 'OPENCLAW_CONTROL_BUSY', 'OPENCLAW_CONTROL_CLOSED', 'PAIR_REQUIRED', 'SESSION_CHANGED']);
        status.textContent = `The source request did not complete. Check the current native configuration and owner grant, then refresh.${codes.has(failure?.code) ? ` Code: ${failure.code}.` : ''}`;
      }
    } finally { if (version === epoch && bound === context()) { busy = false; availability(); } }
  }
  function closeScratch() { scratchSource = null; scratchRevision = null; scratchNotes.value = ''; scratchStatus.textContent = ''; scratch.hidden = true; }
  function openScratch(source) {
    if (!ready || busy || source.kind !== 'heartbeat' || !view.sources.some(row => row.id === source.id && row.kind === 'heartbeat')) return;
    scratchSource = source; scratchRevision = null; scratchNotes.value = ''; scratch.hidden = false; scratchTitle.textContent = `Heartbeat monitor notes · ${source.agentId}`;
    return requestScratch('scratch-get');
  }
  async function requestScratch(action, content) {
    if (!ready || busy || !scratchSource || action === 'scratch-set' && (!permitted || scratchRevision === null)) return;
    if (action === 'scratch-set' && content !== null && (typeof content !== 'string' || new TextEncoder().encode(content).length > scratchMaxBytes || content.includes('\0'))) {
      scratchStatus.textContent = `Use at most ${scratchMaxBytes} UTF-8 bytes of monitor notes.`; return;
    }
    const source = scratchSource, bound = context(), version = epoch;
    const payload = {action, id: source.id, ...(action === 'scratch-set' ? {content, expectedRevision: scratchRevision} : {})};
    busy = true; availability(); scratchStatus.textContent = action === 'scratch-get' ? 'Reading this enrolled heartbeat’s monitor notes…' : 'Saving monitor notes against the current native revision…';
    try {
      const result = nativeHeartbeatScratch(await api('/api/openclaw/sources', payload), source);
      if (version !== epoch || bound !== context() || scratchSource?.id !== source.id) return;
      scratchRevision = result.currentRevision; scratchMaxBytes = result.maxBytes; scratchNotes.value = result.content ?? '';
      scratchStatus.textContent = result.content === null ? 'No note override · the native configured prompt applies.' : result.content === '' ? 'Empty monitor notes saved · scheduled model work is skipped.' : `Monitor notes loaded · native revision ${result.currentRevision}.`;
    } catch {
      if (version === epoch && bound === context() && scratchSource?.id === source.id)
        scratchStatus.textContent = 'The heartbeat notes request did not complete. Reload notes to inspect the current revision and owner background grant before retrying.';
    } finally { if (version === epoch && bound === context()) { busy = false; availability(); } }
  }
  function reset() {
    epoch++; owner = context(); ready = false; permitted = false; busy = false; loaded = false; view = nativeSourceView(null);
    consent.checked = false; closeScratch(); options(agent.input, [], 'Choose a configured native agent'); renderList(); targets();
    status.textContent = 'Connect a selected Timechain to inspect native source bindings.';
  }
  function render(next) {
    if (owner !== context()) reset();
    const wasReady = ready; ready = !!(next?.sessionKey || next?.selectedAgentId);
    const grant = next?.toolAuthority?.grant?.nativeCapabilities;
    permitted = grant?.enabled === true && grant.acknowledged === true && grant.backgroundRuns === true;
    consent.checked = false; targets();
    if (!ready) { reset(); return; }
    if (!wasReady && !loaded) void request({ action: 'list' });
  }
  for (const input of [kind.input, agent.input]) input.addEventListener('change', () => { consent.checked = false; targets(); });
  target.input.addEventListener('change', () => { consent.checked = false; availability(); }); consent.addEventListener('change', availability);
  refresh.addEventListener('click', () => request({ action: 'list' }));
  scratchForm.addEventListener('submit', event => { event.preventDefault(); return requestScratch('scratch-set', scratchNotes.value); });
  scratchRefresh.addEventListener('click', () => requestScratch('scratch-get'));
  scratchConfigured.addEventListener('click', () => requestScratch('scratch-set', null));
  scratchClose.addEventListener('click', () => { closeScratch(); availability(); });
  form.addEventListener('submit', event => { event.preventDefault(); if (!ready || !permitted || !consent.checked || busy) return; try { return request(nativeSourceEnrollment(selection(), view), 'Source enrolled. Each run still requires current owner authority and fresh PoI review.'); } catch (failure) { status.textContent = failure.message; } });
  reset(); return { render, reset };
}

const nativeSecretName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const legacyNativeSecretTarget = value => typeof value === 'string' && value.length <= 256 && /^tts\.(?:providers\.[A-Za-z0-9_-]+|personas\.[A-Za-z0-9_-]+\.providers\.[A-Za-z0-9_-]+)\.apiKey$/.test(value) && value.split('.').every(part => !['constructor', 'prototype', '__proto__'].includes(part));
const nativeSecretTarget = value => legacyNativeSecretTarget(value) || (typeof value==='string' && value.startsWith('/') && value.length<=4096 && value.slice(1).split('/').every(part=>part && !/~(?![01])/.test(part) && !['__proto__','prototype','constructor'].includes(part.replaceAll('~1','/').replaceAll('~0','~'))) && !/[\u0000\r\n]/.test(value));
export function nativeSecretView(value) {
  const targets = new Map(), bindings = new Map();
  for (const row of (Array.isArray(value?.targets) ? value.targets : []).slice(0, 256)) {
    if (nativeSecretTarget(row?.target)) targets.set(row.target, { target: row.target,
      label: typeof row.label === 'string' ? row.label.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) : row.target });
  }
  for (const row of (Array.isArray(value?.bindings) ? value.bindings : []).slice(0, 64)) {
    if (nativeSecretName(row?.name) && nativeSecretTarget(row.target) && row.configured === true)
      bindings.set(row.name, { name: row.name, target: row.target, configured: true, available: row.available === true && targets.has(row.target) });
  }
  return { targets: [...targets.values()], bindings: [...bindings.values()] };
}
export function nativeSecretPayload({ name, target, value }, view) {
  if (!nativeSecretName(name) || !nativeSecretView(view).targets.some(row => row.target === target) ||
      typeof value !== 'string' || !value.length || new TextEncoder().encode(value).length > 16384 || value.includes('\0'))
    throw new Error('Choose a configured native target, a binding name and a dedicated credential.');
  return { action: 'set', name, target, value };
}
export function mountNativeSecretCard({ document: doc, mount, api, context = () => '' }) {
  const make = (tag, text = '', className = '') => { const node = doc.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
  const card = make('section', '', 'native-card native-secret-card'); card.append(make('h2', 'Dedicated native service credentials'));
  const credentialNotice=make('p','','fine-print');card.append(credentialNotice);
  card.append(make('p', 'Choose targets discovered from the native configuration. Setting or removing a credential restarts the managed runtime and cancels dynamic runs, so finish the current primary turn first. Each target uses its own credential.', 'fine-print'));
  const status = make('p', '', 'native-capability-status'); status.id = 'nativeSecretsStatus'; status.setAttribute('role', 'status');
  const refresh = make('button', 'Refresh native credential targets', 'secondary-button'); refresh.type = 'button'; refresh.id = 'refreshNativeSecrets';
  const form = make('form'); form.id = 'nativeSecretForm';
  const fields = make('fieldset', '', 'native-capability-controls'); fields.append(make('legend', 'Dedicated native credential', 'sr-only'));
  function field(id, label, tag = 'input') { const holder = make('label', label, 'field'), input = make(tag); input.id = id; holder.append(input); fields.append(holder); return input; }
  const name = field('nativeSecretName', 'Local binding name'); name.type = 'text'; name.maxLength = 64; name.autocomplete = 'off'; name.placeholder = 'speech-service'; name.required = true;
  const target = field('nativeSecretTarget', 'Configured native credential target', 'select'); target.required = true;
  const credential = field('nativeSecretValue', 'Dedicated credential'); credential.type = 'password'; credential.autocomplete = 'new-password'; credential.maxLength = 16384; credential.required = true; credential.spellcheck = false;
  const credentialFile=field('nativeSecretFile','Or load a UTF-8 credential file (up to 16 KiB)');credentialFile.type='file';credentialFile.accept='.txt,.json,.pem,.key';
  const fileStatus=make('p','','fine-print');fileStatus.id='nativeSecretFileStatus';fields.append(fileStatus);
  const rememberLabel=make('label','','native-check'),remember=make('input');remember.type='checkbox';remember.id='nativeSecretRemember';rememberLabel.append(remember,make('span','Remember on this machine (encrypted local vault)'));fields.append(rememberLabel);
  const save = make('button', 'Save dedicated credential locally', 'primary-button'); save.id = 'saveNativeSecret'; save.type = 'submit';
  const list = make('div', '', 'native-service-list'); list.id = 'nativeSecretBindings'; list.setAttribute('aria-label', 'Configured dedicated native credentials');
  form.append(fields, save); card.append(status, refresh, form, make('h3', 'Local credential bindings'), list); mount.append(card);
  let ready = false, busy = false, loaded = false, epoch = 0, owner = context(), view = nativeSecretView(null), fileValue='',fileRevision=0,supportsEncrypted=false;
  function clearFile(){fileRevision++;fileValue='';credentialFile.value='';fileStatus.textContent='';credential.required=true;}
  credential.addEventListener('input',clearFile);
  credentialFile.addEventListener('change',async()=>{
    const file=credentialFile.files?.[0];clearFile();const revision=fileRevision,bound=context();
    try {
      if(!file)return;
      if(!Number.isSafeInteger(file.size)||file.size<1||file.size>16384)throw new Error('Choose a UTF-8 credential file up to 16 KiB.');
      const value=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
      if(revision!==fileRevision||bound!==context())return;
      if(!value||value.includes('\0'))throw new Error('Choose a nonempty text credential without null bytes.');
      fileValue=value;credential.value='';credential.required=false;fileStatus.textContent='Credential file loaded in local page memory. Its contents will be sent only to the connected local runtime.';
    }catch(failure){if(revision===fileRevision&&bound===context())fileStatus.textContent=failure.message;}
    finally {if(revision===fileRevision)credentialFile.value='';}
  });
  const removals = [];
  function availability() { fields.disabled = !ready || busy || !view.targets.length; save.disabled = fields.disabled; refresh.disabled = !ready || busy; for (const button of removals) button.disabled = !ready || busy; }
  function accept(result) {
    view = nativeSecretView(result); loaded = true; target.replaceChildren(); const empty = make('option', 'Choose a configured native target'); empty.value = ''; target.append(empty);
    for (const row of view.targets) { const option = make('option', row.label); option.value = row.target; target.append(option); }
    target.value = ''; removals.length = 0; list.replaceChildren();
    for (const binding of view.bindings) {
      const row = make('article', '', 'native-service-row'); row.append(make('h4', binding.name), make('p', binding.target), make('p', binding.available ? 'Credential configured locally · value is hidden' : 'Credential configured locally · target is no longer configured'));
      const remove = make('button', 'Remove local credential', 'secondary-button'); remove.type = 'button'; remove.dataset.nativeSecretName = binding.name;
      remove.addEventListener('click', () => request({ action: 'remove', name: binding.name }, 'Dedicated credential removed. The managed native runtime was restarted.'));
      removals.push(remove); row.append(remove); list.append(row);
    }
    if (!view.bindings.length) list.append(make('p', 'No dedicated native credentials are configured.', 'fine-print'));
    availability();
  }
  async function request(payload, success) {
    if (!ready || busy) return; const bound = context(), version = epoch; busy = true; credential.value = '';clearFile(); availability();
    status.textContent = payload.action === 'list' ? 'Inspecting configured native credential targets…' : 'Updating the dedicated local credential binding…';
    try {
      const result = await api('/api/openclaw/secrets', payload);
      if (version !== epoch || bound !== context()) return;
      accept(result); status.textContent = success || (view.targets.length ? `${view.targets.length} configured native credential target${view.targets.length === 1 ? '' : 's'} available.` : 'No credential targets are configured. Configure a native channel, plugin or service in Settings, then refresh.');
    } catch (failure) {
      if (version === epoch && bound === context()) {
        const codes = new Set(['OPENCLAW_NATIVE_SECRET_INVALID', 'OPENCLAW_CONTROL_BUSY', 'OPENCLAW_CONTROL_CLOSED', 'PAIR_REQUIRED', 'SESSION_CHANGED']);
        status.textContent = `The native credential request did not complete. Check its configured target and finish active turns before retrying.${codes.has(failure?.code) ? ` Code: ${failure.code}.` : ''}`;
      }
    } finally { if (version === epoch && bound === context()) { busy = false; credential.value = ''; availability(); } }
  }
  function reset() { epoch++; owner = context(); ready = false; busy = false; loaded = false; name.value = ''; credential.value = '';clearFile();remember.checked=false; view = nativeSecretView(null); accept(null); loaded = false; status.textContent = 'Connect a selected Timechain to configure dedicated native credentials.'; availability(); }
  function render(next) {
    if (owner !== context()) reset(); const wasReady = ready; ready = !!(next?.sessionKey || next?.selectedAgentId);
    supportsEncrypted=typeof next?.config?.baseHash==='string';rememberLabel.hidden=!supportsEncrypted;remember.disabled=!supportsEncrypted;
    credentialNotice.textContent=supportsEncrypted ? 'Add credentials for native channels, plugins and services through write-only fields. Session credentials stay in memory. Remembered credentials use an encrypted, owner-private local vault whose key is protected by filesystem permissions, not an OS keychain. Chat API keys stay in memory.' : 'This older runtime uses its earlier owner-private credential store. Install ChainChat 1.1.0 to choose session-only or encrypted remembered credentials. Direct chat API keys remain in memory.';
    if (!ready) { reset(); return; } availability(); if (!wasReady && !loaded) void request({ action: 'list' });
  }
  refresh.addEventListener('click', () => request({ action: 'list' }));
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!ready || busy) { credential.value = ''; return; }
    let payload; try { payload = nativeSecretPayload({ name: name.value.trim(), target: target.value, value: fileValue || credential.value }, view); }
    catch { status.textContent = 'Choose a configured native target, a valid local binding name and a dedicated credential.'; credential.value = ''; return; }
    if(supportsEncrypted)payload.remember=remember.checked===true; credential.value = ''; return request(payload, 'Dedicated credential saved locally. The managed native runtime was restarted.');
  });
  doc.defaultView?.addEventListener('pagehide', () => { credential.value = '';clearFile(); });
  reset(); return { render, reset };
}

export function initOpenClawSettings({ api, requireConnection, executeCommand, isConnected = () => false, document: doc = globalThis.document, onClose }) {
  const $ = id => doc.getElementById(id), panel = $('openclawPanel');
  let snapshot = null, loading = false, activeSection = 'configuration', selectedFamily = '';
  let connectionKey = '', connectionRevision = 0, pendingRefresh = false;
  let configDirty = false, configSaving = false, configEditRevision = null, nativeCapabilityControls = null, nativeSourceControls = null, nativeSecretControls = null;
  let toolContext = {}, toolSnapshot = null, toolSaving = false;
  const configForm = $('nativeConfigFormMount') ? mountNativeConfigForm({document:doc,mount:$('nativeConfigFormMount'),
    onError:failure=>error(failure?.message || String(failure)),
    onChange:()=>{configDirty=true;},
    onNavigate:()=>section('tools')}) : null;
  const channelSetup=$('nativeChannelSetupMount') ? mountNativeChannelSetup({document:doc,mount:$('nativeChannelSetupMount'),
    context:()=>connectionRevision,onError:failure=>error(failure?.message || String(failure)),
    onInstall:details=>reviewChannelPlugin(details),
    onRefresh:()=>api('/api/openclaw/channels'),
    onSave:payload=>api('/api/openclaw/channels/setup',payload),
    onAction:payload=>api('/api/openclaw/channels/action',payload),onSaved:()=>refresh()}) : null;
  function error(message = '') { $('nativeError').textContent = message; }
  function renderToolStatus() {
    const view = chatToolAccess(toolSnapshot, toolContext);
    const status = toolSaving ? 'Saving tool permissions…' : view.status;
    for (const [id, text] of [['chatToolsStatus', status], ['nativeToolScopeStatus', view.detail]]) {
      const node = $(id);
      if (node && node.textContent !== text) node.textContent = text;
    }
    if ($('chatToolsStatus')) $('chatToolsStatus').title = view.detail;
    const canChange = toolContext.connected && toolContext.agentId && !toolSaving;
    $('nativeToolsForm').querySelector('button[type="submit"]').disabled = !canChange || !toolSnapshot;
    $('disableNativeTools').disabled = !canChange;
  }
  function renderToolActivity(activity, fresh) {
    const node = $('chatToolsActivity');
    if (!node) return;
    const text = chatToolActivity(activity, fresh && activity?.agentId === toolContext.agentId);
    if (node.textContent !== text) node.textContent = text;
    node.hidden = !text;
  }
  function close() {
    doc.querySelector('main.workspace')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    onClose?.();
  }
  function section(name) {
    if (!doc.querySelector(`[data-native-tab="${name}"]`)) name = 'configuration';
    activeSection = name;
    for (const button of doc.querySelectorAll('[data-native-tab]')) {
      const selected = button.dataset.nativeTab === name;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      button.setAttribute('aria-controls', `native-section-${button.dataset.nativeTab}`);
      button.id ||= `native-tab-${button.dataset.nativeTab}`;
    }
    for (const item of doc.querySelectorAll('[data-native-section]')) {
      item.classList.toggle('hidden', item.dataset.nativeSection !== name);
      item.id = `native-section-${item.dataset.nativeSection}`; item.setAttribute('role', 'tabpanel');
      item.setAttribute('aria-labelledby', `native-tab-${item.dataset.nativeSection}`);
    }
  }
  const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  async function serviceAction(action, input, button) {
    error(); if (button) button.disabled = true;
    try { const result = await api('/api/openclaw/automation/' + action, input); await refresh(); return result; }
    catch (failure) { error(failure.message); }
    finally { if (button) button.disabled = false; }
  }
  function renderServices(next) {
    const services = next.services, jobs = services?.jobs || [], channels = services?.channels || [], occurrences = services?.occurrences || [];
    const held = occurrences.filter(item => ['held', 'uncertain', 'pending'].includes(item.status)).length;
    $('nativeServicesStatus').textContent = services ? `${jobs.filter(item => item.enabled).length} active schedules · ${channels.filter(item => item.enabled).length} channel bindings · ${held} pending or held` : 'Managed services are unavailable in this runtime.';
    for (const id of ['nativeCreateJob', 'nativeCreateBinding', 'nativeConnectChannelButton']) $(id).disabled = !services || !next.sessionKey;
    $('nativeWakeAutomation').disabled = !services || !next.sessionKey;
    const destination = $('nativeJobChannel'), previous = destination.value;
    destination.replaceChildren(); const local = doc.createElement('option'); local.value = ''; local.textContent = 'Keep the reviewed result locally'; destination.append(local);
    for (const entry of channels.filter(item => item.enabled)) {
      if (next.selectedAgentId && entry.binding.agentId !== next.selectedAgentId) continue;
      const option = doc.createElement('option'); option.value = entry.id;
      option.textContent = `${entry.name} · ${entry.target.channelId} · ${entry.binding.agentId.slice(0, 8)}`; destination.append(option);
    }
    if ([...destination.options].some(option => option.value === previous)) destination.value = previous;
    function list(id, entries, empty, kind) {
      const container = $(id); container.replaceChildren();
      if (!entries.length) { const note = doc.createElement('p'); note.textContent = empty; container.append(note); return; }
      for (const item of entries) {
        const row = doc.createElement('article'); row.className = 'native-service-row';
        const heading = doc.createElement('h3'); heading.textContent = item.name || `${item.kind === 'cron' ? 'Scheduled request' : 'Channel request'} · ${item.id.slice(0, 8)}`;
        const badge = doc.createElement('span'); badge.className = 'native-service-badge';
        const status = kind ? item.enabled ? 'active' : 'paused' : item.status;
        badge.dataset.state = status; badge.textContent = status.replaceAll('_', ' '); row.append(heading, badge);
        const detail = doc.createElement('p');
        detail.textContent = kind === 'cron' ? `${item.schedule.kind === 'every' ? `Every ${item.schedule.everyMs / 60000} minutes` : item.schedule.kind === 'at' ? new Date(item.schedule.at).toLocaleString() : `${item.schedule.expr} · ${item.schedule.tz}`} · Agent ${item.binding.agentId.slice(0, 8)}` : kind === 'channel' ? `${item.target.channelId} / ${item.target.accountId} · ${item.target.conversationId} · ${item.allowSenders.length} allowed senders · Pause stops incoming messages and dependent scheduled deliveries` : `${new Date(item.createdAt).toLocaleString()} · Agent ${item.binding.agentId.slice(0, 8)}`;
        row.append(detail);
        if (item.reason) { const reason = doc.createElement('p'); reason.textContent = item.status === 'uncertain' ? 'Outcome needs inspection. Automatic retries are stopped.' : item.reason === 'live_admission_unavailable' ? 'Held until an eligible live owner, model and chain are connected.' : item.reason.replaceAll('_', ' '); row.append(reason); }
        if (kind) {
          const actions = doc.createElement('div'); actions.className = 'native-actions';
          const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.className = 'quiet-button'; toggle.textContent = item.enabled ? 'Pause' : 'Resume';
          toggle.addEventListener('click', () => serviceAction(item.enabled ? 'pause' : 'resume', { kind, id: item.id }, toggle)); actions.append(toggle); row.append(actions);
        }
        const content = item.prompt || item.input;
        if (content) { const details = doc.createElement('details'), summary = doc.createElement('summary'), body = doc.createElement('pre');
          summary.textContent = item.result?.text ? 'Request and reviewed result' : 'Request'; body.textContent = content + (item.result?.text ? '\n\n' + item.result.text : ''); details.append(summary, body); row.append(details); }
        container.append(row);
      }
    }
    list('nativeServicesJobs', jobs, 'No native schedules yet.', 'cron');
    list('nativeServicesChannels', channels, 'No channel bindings yet.', 'channel');
    list('nativeServicesRuns', [...occurrences].reverse().slice(0, 30), 'No service requests have been accepted yet.');
  }
  function reference() {
    configForm?.update({family:selectedFamily,query:$('nativeSchemaSearch').value});
    const list = $('nativeSchemaFields'); list.replaceChildren();
    for (const field of schemaFields(snapshot?.schema, $('nativeSchemaSearch').value, selectedFamily)) {
      const row = doc.createElement('div'); row.className = 'native-schema-field';
      const title = doc.createElement('strong'); title.textContent = `${field.name}${field.type ? ` · ${field.type}` : ''}`;
      const description = doc.createElement('p'); description.textContent = field.description;
      row.append(title, description); list.append(row);
    }
  }
  function families() {
    const list = $('nativeConfigFamilies'); list.replaceChildren();
    const entries = schemaFamilies(snapshot?.schema, snapshot?.config?.guards, snapshot?.config?.sections);
    if (selectedFamily && !entries.some(item => item.name === selectedFamily)) selectedFamily = '';
    for (const family of [{ name: '', description: 'All native schema families', guards: [] }, ...entries]) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'native-family-choice';
      button.setAttribute('aria-pressed', String(family.name === selectedFamily));
      button.textContent = `${family.name || 'All settings'}${family.protected ? ' · managed' : ''}`;
      button.title = family.description;
      button.addEventListener('click', () => { selectedFamily = family.name; $('nativeSchemaSearch').value = ''; families(); reference(); });
      list.append(button);
    }
    const chosen = entries.find(item => item.name === selectedFamily);
    $('nativeFamilyNotice').textContent = chosen ? [chosen.reason, chosen.description,
      ...chosen.guards.map(item => `${item.path}: ${item.reason}`),
      !chosen.guards.length ? 'Native schema reference. Settings are applied only when the local managed facade accepts them.' : '',
    ].filter(Boolean).join('\n') : 'All native configuration families are listed. Protected settings remain visible with their managed reasons; this browser does not grant raw operator access.';
  }
  function render(next) {
    snapshot = next;
    const schemaController=typeof next.config?.baseHash==='string';
    $('nativeConnection').textContent = `OpenClaw ${next.runtime?.version || ''} · ${next.sessionKey ? 'Selected agent session' : 'Select a Timechain to use session controls'}`;
    if (!configDirty) { $('nativeConfigEditor').value = pretty(next.config?.editable || {}); configEditRevision = next.config?.revision; }
    configForm?.update({schema:next.schema?.schema || next.schema,uiHints:next.schema?.uiHints || {},
      effective:next.config?.effective || next.nativeConfig?.config || {},editable:next.config?.editable || {},
      guards:nativeBlockedConfigGuards(next),guardFor:(parts,options)=>nativeConfigGuardFor(next,parts,options),revision:next.config?.revision,baseHash:next.config?.baseHash || next.nativeConfig?.hash,
      contextKey:connectionKey,disabled:configSaving||!schemaController,family:selectedFamily,query:$('nativeSchemaSearch').value});
    $('saveNativeConfig').disabled=configSaving||!schemaController;
    $('nativeConfigNotice').textContent = schemaController ? next.config?.notice || 'Changes are validated against the pinned native schema.' : 'Install ChainChat 1.1.0 for native settings forms and guided integration setup. This page shows the configuration reported by your older local runtime.';
    $('nativeProtectedPaths').textContent = (next.config?.protectedPaths || []).map(path => `${path}\n  ${next.config?.guards?.[path] || 'Managed by the local operator facade.'}`).join('\n\n');
    $('nativeSchemaJson').textContent = pretty(next.schema);
    $('nativeEffectiveConfig').textContent = pretty(next.nativeConfig);
    $('nativeRuntimeState').textContent = pretty({ runtime: next.runtime, sessionKey: next.sessionKey, session: next.session });
    $('nativeGoalState').textContent = next.goal ? pretty(next.goal) : 'No native goal is set for this agent.';
    $('startNativeGoal').disabled = !next.sessionKey;
    const contextPolicy = next.contextPolicy || next.runtime?.contextPolicy;
    $('compactNativeSession').disabled = !next.sessionKey || (contextPolicy && contextPolicy.manualSummary !== 'reviewed-optional');
    $('nativeContextPolicy').textContent = contextPolicyText(contextPolicy);
    const commands = $('nativeCommandCatalogue'); commands.replaceChildren();
    for (const item of next.commands || []) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'native-command';
      const name = doc.createElement('strong'); name.textContent = item.name;
      const description = doc.createElement('span'); description.textContent = nativeCommandDescription(item);
      button.append(name, description); button.addEventListener('click', () => { $('nativeCommandInput').value = item.name; $('nativeCommandInput').focus(); }); commands.append(button);
    }
    toolSnapshot = next;
    const grant = next.toolAuthority?.grant || {};
    for (const name of ['evaluate', 'credentials', 'payments']) {
      const checkbox = doc.querySelector(`[data-browser-capability="${name}"]`);
      if (checkbox) checkbox.checked = grant.browserCapabilities?.[name] === true;
    }
    if ($('nativePluginCatalogue')) $('nativePluginCatalogue').textContent = pretty(next.plugins || { notice: 'Install the current local release to use trusted plugins.' });
    if ($('nativeBrowserRuntime')) $('nativeBrowserRuntime').textContent = pretty(next.browserRuntime || { state: 'Install the current local release for managed browser setup.' });
    $('nativeToolsEnabled').checked = grant.enabled === true;
    $('nativeExecutionAllowed').checked = grant.allowExecution === true;
    $('nativeToolsAcknowledged').checked = false;
    $('nativeToolRoots').value = (grant.roots || []).join('\n');
    $('nativeToolHosts').value = (grant.networkHosts || []).join('\n');
    const tools = $('nativeToolChoices'); tools.replaceChildren();
    for (const { name, label: title, details, available, selected } of hostToolChoices(next)) {
      const label = doc.createElement('label'); label.className = 'native-check';
      const checkbox = doc.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.hostTool = name; checkbox.checked = selected;
      checkbox.disabled = !available;
      const text = doc.createElement('span'); text.textContent = `${title} (${name}) · ${details}`;
      label.append(checkbox, text); tools.append(label);
    }
    renderToolStatus();
    nativeCapabilityControls?.render(next);
    nativeSourceControls?.render(next);
    nativeSecretControls?.render(next);
    families(); reference(); renderServices(next);
  }
  async function refresh() {
    if (!isConnected()) return;
    if (loading) { pendingRefresh = true; return; }
    loading = true; error(); const revision = connectionRevision;
    try {
      const next = await api('/api/openclaw');
      if (revision !== connectionRevision || !isConnected()) return;
      render(next); $('nativeConnectedControls').disabled = false;
      if(channelSetup&&typeof next.config?.baseHash==='string')try {
        const channels=await api('/api/openclaw/channels');
        if(revision===connectionRevision&&isConnected())channelSetup.render({...channels,contextKey:connectionKey,disabled:false});
      }catch(failure){if(revision===connectionRevision)error(failure.message);}
      else channelSetup?.render({items:[],disabled:true,contextKey:connectionKey});
    } catch (failure) {
      if (revision === connectionRevision) { toolSnapshot = null; renderToolStatus(); error(failure.message); }
    }
    finally { loading = false; if (pendingRefresh) { pendingRefresh = false; void refresh(); } }
  }
  function open(name = 'configuration') {
    section(typeof name === 'string' ? name : 'configuration');
    panel.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    $('nativeTitle').focus?.({ preventScroll: true });
    if (isConnected()) void refresh();
  }
  function syncConnection({ connected, agentId = '', ...context }) {
    toolContext = { connected, agentId, ...context };
    const next = connected ? `connected:${agentId}` : 'disconnected';
    if (next === connectionKey) { renderToolStatus(); return; }
    connectionKey = next; connectionRevision++; configDirty = false; configSaving=false; configEditRevision = null;
    $('saveNativeConfig').disabled=$('refreshNativeControls').disabled=!connected;
    snapshot = null; selectedFamily = ''; $('nativeConnectedControls').disabled = true;
    toolSnapshot = null; toolSaving = false;
    $('nativeToolsForm').inert = false;
    renderToolStatus(); renderToolActivity(null, false);
    nativeCapabilityControls?.reset();
    nativeSourceControls?.reset();
    nativeSecretControls?.reset();
    configForm?.reset({schema:{},effective:{},editable:{},contextKey:connectionKey,disabled:true});
    channelSetup?.reset();
    pluginPreview = null; pluginNotices = {}; trustCheckbox.checked = false; consentCheckbox.checked = false;
    applyPlugin.disabled = true; previewText.textContent = ''; noticeText.textContent = '';
    consentLabel.classList.add('hidden'); noticeText.classList.add('hidden');
    for (const input of panel.querySelectorAll('input[type="password"]')) input.value = '';
    for (const id of ['nativeRuntimeState', 'nativeEffectiveConfig', 'nativeSchemaJson', 'nativeProtectedPaths', 'nativeGoalState']) $(id).textContent = '';
    for (const id of ['nativeSchemaFields', 'nativeConfigFamilies', 'nativeCommandCatalogue', 'nativeServicesJobs', 'nativeServicesChannels', 'nativeServicesRuns']) $(id).replaceChildren();
    $('nativeConfigEditor').value = '{}'; $('nativeToolRoots').value = ''; $('nativeToolHosts').value = '';
    $('nativeToolChoices').replaceChildren();
    for (const id of ['nativeToolsEnabled', 'nativeExecutionAllowed', 'nativeToolsAcknowledged']) $(id).checked = false;
    for (const field of panel.querySelectorAll('[data-browser-capability]')) field.checked = false;
    $('nativeConnection').textContent = connected ? 'Loading the authenticated local OpenClaw controls…' : 'Open your installed ChainChat app to load authenticated native controls.';
    $('connectNativeControls').classList.toggle('hidden', connected);
    $('nativeFamilyNotice').textContent = 'Connect the local app to load its exact OpenClaw schema.';
    $('nativeContextPolicy').textContent = 'Connect the runtime to read its context policy. A model context window remains bounded.';
    if (connected) void refresh();
  }
  async function run(command) {
    error();
    try {
      const result = await executeCommand(command);
      $('nativeCommandResult').textContent = result?.text || (result?.kind === 'turn' ? 'The native goal turn is opening in ChainChat.' : 'Native command completed.');
      if (!panel.classList.contains('hidden')) await refresh();
    } catch (failure) { error(failure.message); }
  }
  $('openclawSettingsButton').addEventListener('click', open);
  $('chatToolsButton')?.addEventListener('click', () => requireConnection(() => {
    open('tools');
    $('nativeToolsTitle')?.focus?.({ preventScroll: true });
  }));
  $('closeOpenclawPanel').addEventListener('click', close);
  $('connectNativeControls').addEventListener('click', () => requireConnection(() => refresh()));
  const tabs = [...doc.querySelectorAll('[data-native-tab]')];
  for (const button of tabs) {
    button.addEventListener('click', () => section(button.dataset.nativeTab));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const current = tabs.indexOf(button);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      section(tabs[index].dataset.nativeTab); tabs[index].focus();
    });
  }
  section('configuration');
  $('refreshNativeControls').addEventListener('click', () => { configDirty = false; configForm?.reset({contextKey:connectionKey}); void refresh(); });
  $('nativeConfigEditor').addEventListener('input', () => { if (!configDirty) configEditRevision = snapshot?.config?.revision; configDirty = true; });
  $('nativeSchemaSearch').addEventListener('input', reference);
  $('saveNativeConfig').addEventListener('click', async () => {
    if(configSaving||!isConnected())return;
    error();
    const revision=connectionRevision,current=()=>revision===connectionRevision&&isConnected();
    const button=$('saveNativeConfig');button.disabled=$('refreshNativeControls').disabled=true;configSaving=true;configForm?.update({disabled:true});
    try { const payload=configForm ? configForm.getPayload() : {patch:JSON.parse($('nativeConfigEditor').value),revision:configDirty ? configEditRevision : snapshot?.config?.revision,baseHash:snapshot?.nativeConfig?.hash};
      await api('/api/openclaw/config', payload); if(!current())return;
      configDirty = false; configForm?.reset({contextKey:connectionKey}); await refresh(); }
    catch (failure) { if(current())error(failure.message); }
    finally {if(current()){configSaving=false;button.disabled=$('refreshNativeControls').disabled=false;configForm?.update({disabled:false});}}
  });
  $('nativeCommandForm').addEventListener('submit', event => { event.preventDefault(); void run($('nativeCommandInput').value.trim()); });
  $('startNativeGoal').addEventListener('click', () => { const objective = $('nativeGoalObjective').value.trim(); if (objective) void run(`/goal start ${objective}`); else error('Write a goal objective first.'); });
  $('compactNativeSession').addEventListener('click', () => run('/compact'));
  for (const button of doc.querySelectorAll('[data-goal-command]')) button.addEventListener('click', () => run(button.dataset.goalCommand));
  const toolForm = $('nativeToolsForm');
  async function saveToolGrant(grant) {
    if (toolSaving || !toolContext.connected || !toolContext.agentId) return;
    if (grant.enabled) {
      if (!toolSnapshot) return error('Refresh Tool access before applying a grant.');
      if (!grant.acknowledged) return error('Acknowledge the selected permissions before applying this grant.');
      if (grant.tools.some(name => name === 'exec' || name === 'process') && !grant.allowExecution)
        return error('Shell commands and process controls require the separate local execution permission.');
    }
    const revision = connectionRevision;
    toolSaving = true; toolForm.inert = true; renderToolStatus(); error();
    try {
      await api('/api/openclaw/tools', grant);
      if (revision !== connectionRevision) return;
      toolSnapshot = null; renderToolStatus();
      await refresh();
    } catch (failure) {
      if (revision === connectionRevision) error(failure.message);
    } finally {
      if (revision === connectionRevision) {
        toolSaving = false; toolForm.inert = false; renderToolStatus();
      }
    }
  }
  toolForm.addEventListener('input', event => {
    if (event.target !== $('nativeToolsAcknowledged')) $('nativeToolsAcknowledged').checked = false;
  });
  toolForm.addEventListener('submit', event => {
    event.preventDefault();
    const grant = { enabled: $('nativeToolsEnabled').checked, tools: [...toolForm.querySelectorAll('[data-host-tool]:checked')].map(node => node.dataset.hostTool),
      roots: lines($('nativeToolRoots').value), networkHosts: lines($('nativeToolHosts').value),
      allowExecution: $('nativeExecutionAllowed').checked, acknowledged: $('nativeToolsAcknowledged').checked,
      browserCapabilities: Object.fromEntries([...panel.querySelectorAll('[data-browser-capability]')].map(node => [node.dataset.browserCapability, node.checked])) };
    void saveToolGrant(grant);
  });
  $('disableNativeTools').addEventListener('click', () => {
    void saveToolGrant({ enabled: false, tools: [], roots: [], networkHosts: [], allowExecution: false, acknowledged: false });
  });
  nativeCapabilityControls = mountNativeCapabilityCard({ document: doc, mount: $('nativeToolsForm').parentElement,
    api, onSaved: refresh, onError: error, context: () => connectionRevision });
  nativeSourceControls = mountNativeSourceCard({ document: doc, mount: $('nativeToolsForm').parentElement,
    api, context: () => connectionRevision });
  nativeSecretControls = mountNativeSecretCard({ document: doc, mount: $('nativeToolsForm').parentElement,
    api, context: () => connectionRevision });
  $('nativeScheduleTimezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  $('nativeScheduleKind').addEventListener('change', () => {
    for (const item of doc.querySelectorAll('[data-native-schedule]')) item.classList.toggle('hidden', item.dataset.nativeSchedule !== $('nativeScheduleKind').value);
  });
  $('nativeAutomationJobForm').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const schedule = buildAutomationSchedule({ kind: $('nativeScheduleKind').value, at: $('nativeScheduleAt').value,
        minutes: $('nativeScheduleMinutes').value, expr: $('nativeScheduleExpression').value, tz: $('nativeScheduleTimezone').value });
      void serviceAction('job', { name: $('nativeJobName').value.trim(), prompt: $('nativeJobPrompt').value.trim(), schedule,
        ...($('nativeJobChannel').value ? { channelBindingId: $('nativeJobChannel').value } : {}) }, $('nativeCreateJob'));
    } catch (failure) { error(failure.message); }
  });
  $('nativeChannelBindingForm').addEventListener('submit', event => {
    event.preventDefault(); void serviceAction('channel', { name: $('nativeBindingName').value.trim(), channelId: $('nativeBindingChannel').value.trim(),
      accountId: $('nativeBindingAccount').value.trim(), conversationId: $('nativeBindingConversation').value.trim(), allowSenders: lines($('nativeBindingSenders').value) }, $('nativeCreateBinding'));
  });
  $('nativeWakeAutomation').addEventListener('click', () => serviceAction('wake', {}, $('nativeWakeAutomation')));
  function element(name, content, className) {
    const node = doc.createElement(name); if (content) node.textContent = content; if (className) node.className = className; return node;
  }
  const browserMount = $('nativeBrowserMount'); browserMount.replaceChildren();
  const browserCard = element('div', '', 'native-card');
  browserCard.append(element('h2', 'Owned browser · individual action review'), element('p', 'Equip Browser under Host tools and grant exact public hostnames. ChainChat uses its own browser profile. Every individual action is checked before execution. Uploads use your granted folders. Personal browser profiles and private network destinations remain outside this grant.'));
  const browserRuntime = element('pre'); browserRuntime.id = 'nativeBrowserRuntime';
  const installBrowser = element('button', 'Set up managed Chromium'); installBrowser.type = 'button';
  installBrowser.addEventListener('click', async () => { error(); installBrowser.disabled = true;
    try { browserRuntime.textContent = 'Setting up the locked browser locally…'; await api('/api/openclaw/browser/install', {}); await refresh(); }
    catch (failure) { error(failure.message); } finally { installBrowser.disabled = false; }
  });
  browserCard.append(browserRuntime, installBrowser, element('p', 'An existing Chrome, Chromium or Edge binary can also run the separate owned profile. Setup downloads the locked Chromium build when needed; it does not import personal browser data.'));
  for (const [name, description] of [['evaluate', 'Allow model-written page JavaScript · broad page access'], ['credentials', 'Allow interaction with credential fields'], ['payments', 'Allow payment and wallet controls']]) {
    const label = element('label', '', 'native-check'), checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.browserCapability = name;
    checkbox.addEventListener('change', () => { $('nativeToolsAcknowledged').checked = false; });
    label.append(checkbox, element('span', description)); browserCard.append(label);
  }
  browserCard.append(element('p', 'PoI still reviews each concrete action. Fixed target inspection stays active; the JavaScript checkbox controls model-written scripts. Scripts require both credential and payment acknowledgements because field checks cannot sandbox arbitrary JavaScript. Grant these controls only for tasks you intend the agent to perform.'));
  const saveBrowser = element('button', 'Review and apply browser permissions in Tool access'); saveBrowser.type = 'button'; saveBrowser.addEventListener('click', () => {
    section('tools'); $('nativeToolsTitle')?.focus?.();
  }); browserCard.append(saveBrowser); browserMount.append(browserCard);
  const pluginMount = $('nativePluginsMount'); pluginMount.replaceChildren();
  const pluginCard = element('div', '', 'native-card');
  pluginCard.append(element('h2', 'Explicitly trusted native plugins'), element('p', 'Native plugins run inside OpenClaw with your OS permissions and may act outside model hooks. Trust an exact package, version and artifact before installing or activating it. Model tool calls retain PoI review. Updated code needs renewed trust.'));
  const pluginCatalogue = element('pre'); pluginCatalogue.id = 'nativePluginCatalogue'; pluginCard.append(pluginCatalogue);
  const pluginForm = element('form'), operation = element('select'); operation.id = 'nativePluginOperation';
  for (const value of ['install', 'enable', 'update', 'disable', 'uninstall', 'reload', 'configure']) { const option = element('option', value); option.value = value; operation.append(option); }
  const pluginId = element('input'); pluginId.id='nativePluginId';pluginId.type = 'text'; pluginId.placeholder = 'Plugin ID for installed operations'; pluginId.autocomplete = 'off';
  const source = element('textarea'); source.id='nativePluginSource';source.rows = 5; source.spellcheck = false; source.value = '{"source":"npm","spec":"package-name@1.0.0","pin":true}';
  const configuration = element('textarea'); configuration.rows = 4; configuration.spellcheck = false; configuration.value = '{}';
  pluginForm.append(element('label', 'Operation'), operation, element('label', 'Installed plugin ID (leave empty for an install)'), pluginId,
    element('label', 'Native source JSON · npm, ClawHub or a local plugin folder'), source, element('label', 'Nonsecret plugin settings for configure'), configuration);
  const previewButton = element('button', 'Review exact artifact'); previewButton.type = 'submit'; pluginForm.append(previewButton);
  const previewText = element('pre'), trustLabel = element('label', '', 'native-check'), trustCheckbox = element('input'); trustCheckbox.type = 'checkbox';
  trustLabel.append(trustCheckbox, element('span', 'I explicitly trust the displayed package, version and artifact to run native code.'));
  const applyPlugin = element('button', 'Apply reviewed operation'); applyPlugin.type = 'button'; applyPlugin.disabled = true;
  const noticeText = element('pre'), consentLabel = element('label', '', 'native-check'), consentCheckbox = element('input'); consentCheckbox.type = 'checkbox';
  consentLabel.append(consentCheckbox, element('span', 'I reviewed and acknowledge the displayed native policy or capability notice for this exact operation.'));
  consentLabel.classList.add('hidden'); noticeText.classList.add('hidden');
  let pluginPreview = null, pluginNotices = {};
  function reviewChannelPlugin(details) {
    const selection=details?.installSource;
    if(!selection||typeof selection!=='object'||Array.isArray(selection)){error('Inspect this integration in the native plugin catalogue and choose its installation source.');section('plugins');return;}
    operation.value='install';pluginId.value='';source.value=pretty(selection);configuration.value='{}';
    pluginPreview=null;pluginNotices={};trustCheckbox.checked=consentCheckbox.checked=false;applyPlugin.disabled=true;
    previewText.textContent='Review the exact artifact below. Selecting an integration does not install or trust it.';
    noticeText.textContent='';noticeText.classList.add('hidden');consentLabel.classList.add('hidden');
    section('plugins');previewButton.focus?.({preventScroll:true});pluginCard.scrollIntoView?.({behavior:'smooth',block:'start'});
  }
  const showPreview = value => { pluginPreview = value; pluginNotices = {}; consentCheckbox.checked = false; consentLabel.classList.add('hidden'); noticeText.classList.add('hidden'); previewText.textContent = pretty(value); trustCheckbox.checked = false; applyPlugin.disabled = !['disable', 'uninstall'].includes(value?.operation); };
  trustCheckbox.addEventListener('change', () => { applyPlugin.disabled = !pluginPreview || (!trustCheckbox.checked && !['disable', 'uninstall'].includes(pluginPreview.operation)); });
  pluginForm.addEventListener('submit', async event => {
    event.preventDefault(); error(); previewButton.disabled = true;
    try { const payload = { operation: operation.value, ...(pluginId.value.trim() ? { pluginId: pluginId.value.trim() } : { source: JSON.parse(source.value) }) };
      showPreview(await api('/api/openclaw/plugins/preview', payload)); }
    catch (failure) { error(failure.message); } finally { previewButton.disabled = false; }
  });
  applyPlugin.addEventListener('click', async () => {
    if (!pluginPreview) return; error(); applyPlugin.disabled = true;
    try { const view = pluginPreview, artifact = view.artifact;
      const payload = ['disable', 'uninstall'].includes(view.operation) ? { pluginId: view.pluginId } : {
        previewId: view.previewId, trust: { acknowledged: trustCheckbox.checked, trustDigest: view.trustDigest,
          pluginId: artifact?.pluginId, version: artifact?.version, integrity: artifact?.integrity },
        ...(view.operation === 'configure' ? { config: JSON.parse(configuration.value) } : {}) };
      if (Object.keys(pluginNotices).length && !consentCheckbox.checked) throw new Error('Review and explicitly acknowledge the displayed native notices before retrying.');
      if (pluginNotices.capabilities) payload.acknowledgeCapabilities = { reviewToken: pluginNotices.capabilities.reviewToken };
      if (pluginNotices['install-policy']) payload.acknowledgeInstallPolicyWarning = true;
      const result = await api('/api/openclaw/plugins/' + view.operation, payload);
      if (result.preview) showPreview(result.preview); else { pluginPreview = null; previewText.textContent = pretty(result); trustCheckbox.checked = false; }
      await refresh();
    } catch (failure) { error(failure.message);
      if (failure.pluginNotice) { pluginNotices[failure.pluginNotice.kind] = failure.pluginNotice; noticeText.textContent = pretty(Object.values(pluginNotices)); noticeText.classList.remove('hidden'); consentLabel.classList.remove('hidden'); consentCheckbox.checked = false; }
    } finally { applyPlugin.disabled = !pluginPreview || !trustCheckbox.checked; }
  });
  pluginCard.append(pluginForm, previewText, trustLabel, noticeText, consentLabel, applyPlugin); pluginMount.append(pluginCard);
  function addCredential() {
    const container = $('nativeCredentialRows'); if (container.children.length >= 16) return;
    const row = doc.createElement('div'); row.className = 'native-credential-row';
    const nameLabel = doc.createElement('label'); nameLabel.className = 'field'; nameLabel.textContent = 'Native credential field';
    const name = doc.createElement('input'); name.type = 'text'; name.required = true; name.maxLength = 64; name.autocomplete = 'off'; name.placeholder = 'botToken'; name.dataset.credentialName = ''; nameLabel.append(name);
    const secretLabel = doc.createElement('label'); secretLabel.className = 'field'; secretLabel.textContent = 'Secret value (local memory only)';
    const secret = doc.createElement('input'); secret.type = 'password'; secret.required = true; secret.maxLength = 8192; secret.autocomplete = 'off'; secret.spellcheck = false; secret.dataset.credentialValue = ''; secretLabel.append(secret);
    const remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'quiet-button'; remove.textContent = 'Remove'; remove.addEventListener('click', () => row.remove());
    row.append(nameLabel, secretLabel, remove); container.append(row);
  }
  addCredential(); $('nativeAddCredential').addEventListener('click', addCredential);
  const channelPluginLabel = element('label', 'Trusted native plugin ID · defaults to the channel ID', 'field');
  const channelPlugin = element('input'); channelPlugin.type = 'text'; channelPlugin.maxLength = 256; channelPlugin.autocomplete = 'off'; channelPlugin.placeholder = 'telegram'; channelPluginLabel.append(channelPlugin);
  $('nativeChannelConnectForm').prepend(element('p', 'Enable the matching channel plugin in Trusted native plugins first. Bundled OpenClaw channel plugins can be reviewed there with their exact installed artifact.'), channelPluginLabel);
  $('nativeChannelConnectForm').addEventListener('submit', async event => {
    event.preventDefault(); error(); const button = $('nativeConnectChannelButton'); button.disabled = true;
    try {
      const config = JSON.parse($('nativeChannelConfig').value);
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Native account settings must be a JSON object.');
      const credentials = {};
      for (const row of $('nativeCredentialRows').children) {
        const name = row.querySelector('[data-credential-name]').value.trim();
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || ['constructor', 'prototype'].includes(name) || Object.keys(credentials).some(key => key.toLowerCase() === name.toLowerCase())) throw new Error('Choose unique native credential field names.');
        credentials[name] = row.querySelector('[data-credential-value]').value;
      }
      if (!Object.keys(credentials).length) throw new Error('Add the credential field required by this native channel.');
      await api('/api/openclaw/channel/connect', { channelId: $('nativeConnectChannel').value.trim(), accountId: $('nativeConnectAccount').value.trim(),
        ...(channelPlugin.value.trim() ? { pluginId: channelPlugin.value.trim() } : {}), config, credentials });
      $('nativeServicesNotice').textContent = 'Native channel credentials connected in local runtime memory. Reconnect after restarting ChainChat.';
      await refresh();
    } catch (failure) { error(failure.message); }
    finally { for (const input of doc.querySelectorAll('[data-credential-value]')) input.value = ''; button.disabled = false; }
  });
  const servicePoll = setInterval(() => { if (isConnected() && doc.visibilityState !== 'hidden' && ['channels', 'schedules', 'activity'].includes(activeSection)) void refresh(); }, 5000);
  servicePoll.unref?.();
  return { open, close, refresh, syncConnection, renderToolActivity, isOpen: () => !panel.classList.contains('hidden') };
}
