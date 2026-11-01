const pretty = value => JSON.stringify(value ?? null, null, 2);
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
export function schemaFields(schema, query = '') {
  const result = [], filter = query.trim().toLowerCase();
  function walk(node, prefix = '', depth = 0) {
    if (!node || typeof node !== 'object' || depth > 15 || result.length > 500) return;
    for (const [key, child] of Object.entries(node.properties || {})) {
      const name = prefix ? `${prefix}.${key}` : key;
      const description = String(child.description || child.title || '');
      if (!filter || `${name} ${description}`.toLowerCase().includes(filter)) result.push({ name, description: description.slice(0, 1500), type: child.type || (child.properties ? 'object' : '') });
      walk(child, name, depth + 1);
    }
  }
  walk(schema?.schema || schema);
  return result.slice(0, 500);
}
export function initOpenClawSettings({ api, requireConnection, executeCommand, document: doc = globalThis.document, onClose }) {
  const $ = id => doc.getElementById(id), panel = $('openclawPanel');
  let snapshot = null, loading = false, activeSection = 'configuration';
  function error(message = '') { $('nativeError').textContent = message; }
  function close() {
    panel.classList.add('hidden');
    doc.querySelector('main.workspace')?.classList.remove('hidden');
    doc.querySelector('.beta-access')?.classList.remove('hidden');
    $('chain-auditor')?.classList.remove('hidden');
    onClose?.();
  }
  function section(name) {
    activeSection = name;
    for (const button of doc.querySelectorAll('[data-native-tab]')) button.setAttribute('aria-selected', String(button.dataset.nativeTab === name));
    for (const item of doc.querySelectorAll('[data-native-section]')) item.classList.toggle('hidden', item.dataset.nativeSection !== name);
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
        if (item.reason) { const reason = doc.createElement('p'); reason.textContent = item.status === 'uncertain' ? 'Outcome needs inspection. Automatic retries are stopped.' : item.reason === 'live_admission_unavailable' ? 'Held until an eligible live owner, model, wallet and chain are connected.' : item.reason.replaceAll('_', ' '); row.append(reason); }
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
    const list = $('nativeSchemaFields'); list.replaceChildren();
    for (const field of schemaFields(snapshot?.schema, $('nativeSchemaSearch').value)) {
      const row = doc.createElement('div'); row.className = 'native-schema-field';
      const title = doc.createElement('strong'); title.textContent = `${field.name}${field.type ? ` · ${field.type}` : ''}`;
      const description = doc.createElement('p'); description.textContent = field.description;
      row.append(title, description); list.append(row);
    }
  }
  function render(next) {
    snapshot = next;
    $('nativeConnection').textContent = `OpenClaw ${next.runtime?.version || ''} · ${next.sessionKey ? 'Selected agent session' : 'Select a Timechain to use session controls'}`;
    $('nativeConfigEditor').value = pretty(next.config?.editable || {});
    $('nativeConfigNotice').textContent = next.config?.notice || 'Changes are validated against the pinned native schema.';
    $('nativeProtectedPaths').textContent = (next.config?.protectedPaths || []).join('\n');
    $('nativeSchemaJson').textContent = pretty(next.schema);
    $('nativeEffectiveConfig').textContent = pretty(next.nativeConfig);
    $('nativeRuntimeState').textContent = pretty({ runtime: next.runtime, sessionKey: next.sessionKey, session: next.session });
    $('nativeGoalState').textContent = next.goal ? pretty(next.goal) : 'No native goal is set for this agent.';
    $('startNativeGoal').disabled = !next.sessionKey;
    $('compactNativeSession').disabled = !next.sessionKey;
    const commands = $('nativeCommandCatalogue'); commands.replaceChildren();
    for (const item of next.commands || []) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'native-command';
      const name = doc.createElement('strong'); name.textContent = item.name;
      const description = doc.createElement('span'); description.textContent = `${item.description}${item.mode ? ` · ${item.mode}` : ''}`;
      button.append(name, description); button.addEventListener('click', () => { $('nativeCommandInput').value = item.name; $('nativeCommandInput').focus(); }); commands.append(button);
    }
    const grant = next.toolAuthority?.grant || {};
    for (const name of ['evaluate', 'credentials', 'payments']) {
      const checkbox = doc.querySelector(`[data-browser-capability="${name}"]`);
      if (checkbox) checkbox.checked = grant.browserCapabilities?.[name] === true;
    }
    if ($('nativePluginCatalogue')) $('nativePluginCatalogue').textContent = pretty(next.plugins || { notice: 'Install the current local release to use trusted plugins.' });
    if ($('nativeBrowserRuntime')) $('nativeBrowserRuntime').textContent = pretty(next.browserRuntime || { state: 'Install the current local release for managed browser setup.' });
    $('nativeToolsEnabled').checked = grant.enabled === true;
    $('nativeExecutionAllowed').checked = grant.allowExecution === true;
    $('nativeToolsAcknowledged').checked = grant.acknowledged === true;
    $('nativeToolRoots').value = (grant.roots || []).join('\n');
    $('nativeToolHosts').value = (grant.networkHosts || []).join('\n');
    const tools = $('nativeToolChoices'); tools.replaceChildren();
    for (const entry of next.toolCatalogue || []) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (!name) continue;
      const label = doc.createElement('label'); label.className = 'native-check';
      const checkbox = doc.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.hostTool = name; checkbox.checked = (grant.tools || []).includes(name);
      checkbox.disabled = entry.available === false;
      const text = doc.createElement('span'); text.textContent = typeof entry === 'string' ? name : `${name}${entry.description ? ` · ${entry.description}` : ''}`;
      label.append(checkbox, text); tools.append(label);
    }
    reference(); renderServices(next);
  }
  async function refresh() {
    if (loading) return; loading = true; error();
    try { render(await api('/api/openclaw')); } catch (failure) { error(failure.message); }
    finally { loading = false; }
  }
  function open() {
    requireConnection(() => {
      for (const item of doc.querySelectorAll('main.workspace,.beta-access,#chain-auditor,#installNotice')) item.classList.add('hidden');
      panel.classList.remove('hidden'); section('configuration'); void refresh();
    });
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
  $('closeOpenclawPanel').addEventListener('click', close);
  for (const button of doc.querySelectorAll('[data-native-tab]')) button.addEventListener('click', () => section(button.dataset.nativeTab));
  $('refreshNativeControls').addEventListener('click', refresh);
  $('nativeSchemaSearch').addEventListener('input', reference);
  $('saveNativeConfig').addEventListener('click', async () => {
    error();
    try { const patch = JSON.parse($('nativeConfigEditor').value); await api('/api/openclaw/config', { patch, revision: snapshot?.config?.revision }); await refresh(); }
    catch (failure) { error(failure.message); }
  });
  $('nativeCommandForm').addEventListener('submit', event => { event.preventDefault(); void run($('nativeCommandInput').value.trim()); });
  $('startNativeGoal').addEventListener('click', () => { const objective = $('nativeGoalObjective').value.trim(); if (objective) void run(`/goal start ${objective}`); else error('Write a goal objective first.'); });
  $('compactNativeSession').addEventListener('click', () => run('/compact'));
  for (const button of doc.querySelectorAll('[data-goal-command]')) button.addEventListener('click', () => run(button.dataset.goalCommand));
  $('nativeToolsForm').addEventListener('submit', async event => {
    event.preventDefault(); error();
    const grant = { enabled: $('nativeToolsEnabled').checked, tools: [...doc.querySelectorAll('[data-host-tool]:checked')].map(node => node.dataset.hostTool),
      roots: lines($('nativeToolRoots').value), networkHosts: lines($('nativeToolHosts').value),
      allowExecution: $('nativeExecutionAllowed').checked, acknowledged: $('nativeToolsAcknowledged').checked,
      browserCapabilities: Object.fromEntries([...doc.querySelectorAll('[data-browser-capability]')].map(node => [node.dataset.browserCapability, node.checked])) };
    try { await api('/api/openclaw/tools', grant); await refresh(); } catch (failure) { error(failure.message); }
  });
  $('disableNativeTools').addEventListener('click', async () => {
    try { await api('/api/openclaw/tools', { enabled: false, tools: [], roots: [], networkHosts: [], allowExecution: false, acknowledged: false }); await refresh(); }
    catch (failure) { error(failure.message); }
  });
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
    label.append(checkbox, element('span', description)); browserCard.append(label);
  }
  browserCard.append(element('p', 'PoI still reviews each concrete action. Fixed target inspection stays active; the JavaScript checkbox controls model-written scripts. Scripts require both credential and payment acknowledgements because field checks cannot sandbox arbitrary JavaScript. Grant these controls only for tasks you intend the agent to perform.'));
  const saveBrowser = element('button', 'Save current host and browser permissions'); saveBrowser.type = 'button'; saveBrowser.addEventListener('click', () => $('nativeToolsForm').requestSubmit()); browserCard.append(saveBrowser); browserMount.append(browserCard);
  const pluginMount = $('nativePluginsMount'); pluginMount.replaceChildren();
  const pluginCard = element('div', '', 'native-card');
  pluginCard.append(element('h2', 'Explicitly trusted native plugins'), element('p', 'Native plugins run inside OpenClaw with your OS permissions and may act outside model hooks. Trust an exact package, version and artifact before installing or activating it. Model tool calls retain PoI review. Updated code needs renewed trust.'));
  const pluginCatalogue = element('pre'); pluginCatalogue.id = 'nativePluginCatalogue'; pluginCard.append(pluginCatalogue);
  const pluginForm = element('form'), operation = element('select'); operation.id = 'nativePluginOperation';
  for (const value of ['install', 'enable', 'update', 'disable', 'uninstall', 'reload', 'configure']) { const option = element('option', value); option.value = value; operation.append(option); }
  const pluginId = element('input'); pluginId.type = 'text'; pluginId.placeholder = 'Plugin ID for installed operations'; pluginId.autocomplete = 'off';
  const source = element('textarea'); source.rows = 5; source.spellcheck = false; source.value = '{"source":"npm","spec":"package-name@1.0.0","pin":true}';
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
  const servicePoll = setInterval(() => { if (!panel.classList.contains('hidden') && activeSection === 'services') void refresh(); }, 5000);
  servicePoll.unref?.();
  return { open, close, refresh, isOpen: () => !panel.classList.contains('hidden') };
}
