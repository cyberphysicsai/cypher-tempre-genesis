// Render the installed OpenClaw wizard protocol. No provider credentials are read
// from a model connection or retained after a submitted native secret field.
const text = (value, maximum = 2000) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, maximum) : '';
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
const providerId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) && !value.startsWith('chainchat-');
const stepTypes = new Set(['note', 'select', 'text', 'confirm', 'multiselect', 'progress', 'action']);
const secretFields = new Set(['apikey', 'xapikey', 'xauthtoken', 'xauthkey', 'token', 'password', 'secret', 'authorization', 'proxyauthorization', 'cookie', 'setcookie',
  'credential', 'credentials', 'accesskey', 'accesskeyid', 'secretaccesskey', 'accesstoken', 'refreshtoken', 'sessiontoken']);

function jsonValue(value, maximum = 32768, depthLimit = 12) {
  let nodes = 0;
  function visit(item, depth = 0) {
    if (++nodes > 8192 || depth > depthLimit || ![null, undefined].includes(item) && !['object', 'string', 'number', 'boolean'].includes(typeof item)) throw new Error('The native value exceeds the supported JSON limit.');
    if (item === undefined || typeof item === 'number' && !Number.isFinite(item)) throw new Error('The native value is not JSON.');
    if (item && typeof item === 'object') {
      if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('The native value is not plain JSON.');
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe native JSON key.');
        visit(child, depth + 1);
      }
    }
  }
  visit(value); const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > maximum) throw new Error('The native value exceeds its byte limit.');
  return JSON.parse(encoded);
}

export function nativeAuthorizationURL(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\0\r\n]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function nativeAuthStatusView(value) {
  const providers = new Map();
  for (const row of (Array.isArray(value?.providers) ? value.providers : []).slice(0, 512)) {
    if (!providerId(row?.provider)) continue;
    providers.set(row.provider, { provider: row.provider, name: text(row.displayName, 200) || row.provider, status: text(row.status, 80),
      profiles: (Array.isArray(row.profiles) ? row.profiles : []).slice(0, 64).filter(profile => opaque(profile?.profileId)).map(profile => ({
        id: profile.profileId, name: text(profile.displayName, 200) || profile.profileId, type: text(profile.type, 80),
        status: text(profile.status, 80), logoutSupported: profile.logoutSupported === true })) });
  }
  const seen = new Set(), capabilities = [];
  for (const row of (Array.isArray(value?.providerCapabilities) ? value.providerCapabilities : []).slice(0, 512)) {
    if (!providerId(row?.provider) || seen.has(row.provider)) continue;
    seen.add(row.provider); const choices = new Set();
    capabilities.push({ provider: row.provider, apiKeySupported: row.apiKeySupported === true,
      loginOptions: (Array.isArray(row.loginOptions) ? row.loginOptions : []).slice(0, 100).filter(option => opaque(option?.id) && !choices.has(option.id) && choices.add(option.id)).map(option => ({
        id: option.id, label: text(option.label, 200) || option.id, hint: text(option.hint, 1000), kind: text(option.kind, 80), requiresSetup: option.requiresSetup === true })) });
  }
  return { providers: [...providers.values()], capabilities, available: value?.available !== false && (providers.size > 0 || capabilities.length > 0), notice: text(value?.notice) };
}

export function nativeWizardView(value) {
  const status = ['running', 'done', 'cancelled', 'error'].includes(value?.status) ? value.status : '';
  const result = { sessionId: opaque(value?.sessionId) ? value.sessionId : '', done: value?.done === true, status,
    answerRejected: typeof value?.error === 'string' && value.error.length > 0, step: null };
  const raw = value?.step;
  if (!raw || !opaque(raw.id) || !stepTypes.has(raw.type)) return result;
  const options = [];
  for (const option of (Array.isArray(raw.options) ? raw.options : []).slice(0, 256)) {
    try { options.push({ value: jsonValue(option.value), label: text(option.label, 500), hint: text(option.hint, 1000) }); } catch { /* Unsupported values never become executable controls. */ }
  }
  let initialValue;
  if (raw.sensitive !== true && raw.initialValue !== undefined) { try { initialValue = jsonValue(raw.initialValue); } catch {} }
  result.step = { id: raw.id, type: raw.type, title: text(raw.title, 500), message: text(raw.message, 16000), options,
    sensitive: raw.sensitive === true, placeholder: text(raw.placeholder, 500),
    executor: ['client', 'gateway'].includes(raw.executor) ? raw.executor : '', externalUrl: nativeAuthorizationURL(raw.externalUrl),
    ...(initialValue !== undefined ? { initialValue } : {}),
    deviceCode: typeof raw.deviceCode?.code === 'string' && raw.deviceCode.code.length <= 512 ? { code: text(raw.deviceCode.code, 512),
      message: text(raw.deviceCode.message, 2000), expiresInMinutes: Number.isInteger(raw.deviceCode.expiresInMinutes) && raw.deviceCode.expiresInMinutes > 0 && raw.deviceCode.expiresInMinutes <= 1440 ? raw.deviceCode.expiresInMinutes : null } : null };
  return result;
}

export function nativeWizardAnswer(step, value) {
  if (!step || !opaque(step.id) || !stepTypes.has(step.type)) throw new Error('Refresh the current native sign-in step.');
  if (['note', 'action'].includes(step.type)) return { stepId: step.id };
  if (step.type === 'progress') return undefined;
  if (step.type === 'text') {
    if (typeof value !== 'string' || value.length > 16384) throw new Error('Enter a bounded text answer.');
    return { stepId: step.id, value };
  }
  if (step.type === 'confirm') {
    if (typeof value !== 'boolean') throw new Error('Choose Yes or No explicitly.');
    return { stepId: step.id, value };
  }
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const known = item => step.options.some(option => same(option.value, item));
  if (step.type === 'select' && !known(value) || step.type === 'multiselect' && (!Array.isArray(value) || value.length > step.options.length || !value.every(known))) throw new Error('Choose the options advertised by this native step.');
  return { stepId: step.id, value: jsonValue(value) };
}

export function nativeProviderConfiguration(provider, source) {
  if (!providerId(provider)) throw new Error('Enter the installed or custom native provider ID.');
  let configuration;
  try { configuration = JSON.parse(source); } catch { throw new Error('Enter valid nonsecret provider JSON.'); }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('Native provider configuration must be a JSON object.');
  configuration = jsonValue(configuration, 262144, 24);
  function inspect(value) {
    if (typeof value === 'string') {
      if (/\0|\$\{/.test(value)) throw new Error('Environment and executable expansions are not configuration values.');
      if (/^https?:/i.test(value)) {
        let url; try { url = new URL(value); } catch { throw new Error('Use a valid provider URL.'); }
        if (url.username || url.password || [...url.searchParams.keys()].some(key => secretFields.has(key.toLowerCase().replace(/[-_]/g, '')))) throw Object.assign(new Error('Use the native credential controls for secrets, not configuration JSON.'), { code: 'SECRET_IN_NATIVE_CONFIG' });
      }
    }
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (secretFields.has(key.toLowerCase().replace(/[-_]/g, ''))) throw Object.assign(new Error('Use the native credential controls for secrets, not configuration JSON.'), { code: 'SECRET_IN_NATIVE_CONFIG' });
      inspect(child);
    }
  }
  inspect(configuration); return { provider, configuration };
}

export function mountNativeAuth({ document: doc, mount, api, context = () => '', isBusy = () => false,
  onBusy = () => {}, onUpdated = async () => {}, openSettings = () => {}, createSessionId = () => crypto.randomUUID() }) {
  const make = (tag, content = '', className = '') => { const node = doc.createElement(tag); node.textContent = content; node.className = className; return node; };
  const details = make('details', '', 'native-auth'), summary = make('summary', 'Native provider sign-in & configuration');
  const refreshButton = make('button', 'Read installed provider options', 'secondary-button'); refreshButton.type = 'button';
  const status = make('p', 'Provider credentials stay in local OpenClaw. This panel never copies a saved API connection key.', 'fine-print'); status.setAttribute('role', 'status');
  const options = make('div', '', 'native-auth-options'), profiles = make('div', '', 'native-auth-profiles'), wizard = make('section', '', 'native-auth-wizard');
  const keyProviderLabel = make('label', 'Native provider ID', 'field'), keyProvider = make('input'); keyProvider.type = 'text'; keyProvider.autocomplete = 'off'; keyProvider.maxLength = 64; keyProvider.setAttribute('list', 'nativeAuthProviderIds'); keyProviderLabel.append(keyProvider);
  const providerIds = make('datalist'); providerIds.id = 'nativeAuthProviderIds';
  const keyLabel = make('label', 'New native API key · never prefilled', 'field'), keyInput = make('input'); keyInput.type = 'password'; keyInput.autocomplete = 'off'; keyInput.spellcheck = false; keyInput.maxLength = 16384; keyLabel.append(keyInput);
  const saveKey = make('button', 'Store key in native OpenClaw', 'secondary-button'); saveKey.type = 'button';
  const keyFields = make('div', '', 'native-auth-key'); keyFields.append(keyProviderLabel, keyLabel, providerIds, saveKey);
  const advanced = make('details', '', 'native-auth-configuration'); advanced.append(make('summary', 'Custom native provider · nonsecret JSON'));
  const configProviderLabel = make('label', 'Custom provider ID', 'field'), configProvider = make('input'); configProvider.type = 'text'; configProvider.maxLength = 64; configProvider.autocomplete = 'off'; configProviderLabel.append(configProvider);
  const configLabel = make('label', 'Configuration validated against OpenClaw’s provider schema', 'field'), configInput = make('textarea'); configInput.rows = 7; configInput.value = '{}'; configInput.spellcheck = false; configInput.maxLength = 262144; configLabel.append(configInput);
  const schemaButton = make('button', 'Inspect the native schema in Settings', 'text-button'); schemaButton.type = 'button'; schemaButton.addEventListener('click', openSettings);
  const saveConfig = make('button', 'Validate & save native provider', 'secondary-button'); saveConfig.type = 'button';
  advanced.append(make('p', 'Use the actual native provider schema. Keep API keys, tokens, authorization headers and other secrets in the credential or sign-in controls.', 'fine-print'), schemaButton, configProviderLabel, configLabel, saveConfig);
  details.append(summary, refreshButton, status, options, profiles, keyFields, wizard, advanced); mount.append(details);
  let owner = context(), epoch = 0, busy = false, parentLocked = false, sessionId = '', currentStep = null, stepInput = null, optionInputs = [], view = nativeAuthStatusView(null);
  const passwords = () => { keyInput.value = ''; if (stepInput) stepInput.value = ''; };
  function sync() {
    if (owner !== context()) { reset(); return; }
    for (const button of details.querySelectorAll('button')) button.disabled = busy || isBusy() || !!sessionId && (button.dataset.nativeAuthLogin === 'true' || button === saveKey || button === saveConfig);
    keyProvider.disabled = keyInput.disabled = configProvider.disabled = configInput.disabled = busy || isBusy() || !!sessionId;
  }
  function terminal(next) {
    if (!next.done && !['done', 'cancelled', 'error'].includes(next.status)) return false;
    passwords(); currentStep = null; sessionId = ''; wizard.replaceChildren();
    status.textContent = next.status === 'done' ? 'Native sign-in completed. Refresh native models to inspect configured availability.' : next.status === 'cancelled' ? 'Native sign-in cancelled.' : 'Native sign-in ended without completion. Inspect local OpenClaw and retry.';
    return next.status === 'done';
  }
  async function request(payload, consume, { readonly = false, updated = false } = {}) {
    if (busy || isBusy()) return;
    const version = epoch, bound = context(), sensitiveAnswer = payload?.answer && currentStep?.sensitive === true; busy = true; if (!readonly) { parentLocked = true; onBusy(true); } sync();
    let completed = false;
    try {
      const result = await api('/api/openclaw/auth', payload);
      if (bound !== context() || version !== epoch) return;
      completed = consume(result) === true;
    } catch { if (bound === context() && version === epoch) {
      status.textContent = 'The native authentication operation did not complete. Check local OpenClaw and retry.';
      if (payload?.action === 'login' && sessionId && !currentStep) {
        wizard.replaceChildren(); wizard.append(make('p', 'The native sign-in state is unconfirmed. Check its status or cancel before starting another sign-in.', 'fine-print')); wizardActions();
      }
    } }
    finally {
      if (payload?.apiKey) payload.apiKey = '';
      if (sensitiveAnswer) payload.answer.value = '';
      passwords();
      if (version === epoch) { busy = false; if (!readonly) { parentLocked = false; onBusy(false); } sync(); }
    }
    if ((updated || completed) && bound === context() && version === epoch) { try { await onUpdated(); } catch { status.textContent += ' Model availability can be refreshed separately.'; } }
  }
  function renderStatus(raw) {
    view = nativeAuthStatusView(raw); options.replaceChildren(); profiles.replaceChildren(); providerIds.replaceChildren();
    for (const capability of view.capabilities) {
      const group = make('article', '', 'native-auth-provider'); group.append(make('h4', capability.provider));
      if (capability.apiKeySupported) { const item = make('option'); item.value = capability.provider; providerIds.append(item); }
      for (const choice of capability.loginOptions) {
        const button = make('button', choice.label, 'secondary-button'); button.type = 'button';
        button.title = choice.hint; button.dataset.nativeAuthLogin = 'true'; group.append(button);
        if (choice.hint) group.append(make('p', choice.hint, 'fine-print'));
        if (choice.requiresSetup) group.append(make('p', 'This installed option includes a native setup flow. Review each step before continuing.', 'fine-print'));
        button.addEventListener('click', async () => {
          if (busy || isBusy() || sessionId) return; const id = createSessionId();
          if (!opaque(id)) return; sessionId = id; status.textContent = 'Starting the installed native sign-in wizard…';
          await request({ action: 'login', authChoice: choice.id, sessionId: id }, receiveWizard);
        });
      }
      options.append(group);
    }
    for (const provider of view.providers) {
      const row = make('article', '', 'native-auth-provider'); row.append(make('h4', provider.name), make('p', provider.status || 'Status not reported', 'fine-print'));
      for (const profile of provider.profiles) {
        row.append(make('p', `${profile.name} · ${profile.type} · ${profile.status}`, 'fine-print'));
        if (profile.logoutSupported) {
          const logout = make('button', `Remove saved sign-in · ${profile.name}`, 'text-button'); logout.type = 'button'; row.append(logout);
          logout.addEventListener('click', () => request({ action: 'logout', provider: provider.provider, profileIds: [profile.id] }, () => { status.textContent = 'Native saved sign-in removal request completed. Read status to inspect the result.'; return true; }, { updated: true }));
        }
      }
      profiles.append(row);
    }
    if (!view.available) options.append(make('p', view.notice || 'No installed provider authentication options are reported. Custom provider configuration remains available.', 'fine-print'));
    sync();
  }
  function receiveWizard(raw) {
    const next = nativeWizardView(raw); if (next.sessionId) sessionId = next.sessionId;
    if (next.done || ['done', 'cancelled', 'error'].includes(next.status)) return terminal(next);
    passwords(); currentStep = next.step; stepInput = null; optionInputs = []; wizard.replaceChildren();
    if (next.answerRejected) status.textContent = 'The native wizard did not accept that answer. Review the current field and try again.';
    if (!currentStep) { wizard.append(make('p', 'No renderable native step was returned. Check progress or cancel this sign-in.', 'fine-print')); wizardActions(); return false; }
    const step = currentStep; wizard.append(make('h4', step.title || 'Native sign-in step'), make('p', step.message, 'native-wizard-message'));
    if (step.externalUrl) { const link = make('a', `Open provider sign-in · ${new URL(step.externalUrl).hostname}`, 'secondary-button'); link.href = step.externalUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; wizard.append(link); }
    if (step.deviceCode) wizard.append(make('p', step.deviceCode.message, 'fine-print'), make('code', step.deviceCode.code, 'native-device-code'),
      make('p', step.deviceCode.expiresInMinutes ? `Code expires in ${step.deviceCode.expiresInMinutes} minutes. Enter it only for the sign-in you started.` : 'Enter this code only for the provider sign-in you started.', 'fine-print'));
    const advance = value => { let answer; try { answer = nativeWizardAnswer(step, value); } catch { status.textContent = 'Choose a valid answer for the current native step.'; return; }
      passwords(); return request({ action: 'next', sessionId, ...(answer ? { answer } : {}) }, receiveWizard); };
    if (step.type === 'text') { const label = make('label', step.title || 'Native step answer', 'field'); stepInput = make('input'); stepInput.type = step.sensitive ? 'password' : 'text'; stepInput.autocomplete = 'off'; stepInput.spellcheck = false; stepInput.maxLength = 16384; stepInput.placeholder = step.placeholder; stepInput.value = !step.sensitive && ['string', 'number', 'boolean'].includes(typeof step.initialValue) ? String(step.initialValue) : ''; label.append(stepInput); wizard.append(label);
      const submit = actionButton('Submit native answer', () => { const value = stepInput.value; return advance(value); }); wizard.append(submit);
      stepInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void advance(stepInput.value); } });
    } else if (step.type === 'select' || step.type === 'multiselect') {
      for (let index = 0; index < step.options.length; index++) { const option = step.options[index];
        if (step.type === 'select') wizard.append(actionButton(option.label, () => advance(option.value)));
        else { const label = make('label', '', 'native-check'), input = make('input'); input.type = 'checkbox'; input.checked = Array.isArray(step.initialValue) && step.initialValue.some(value => JSON.stringify(value) === JSON.stringify(option.value)); label.append(input, make('span', option.label)); wizard.append(label); optionInputs.push({ input, value: option.value }); }
        if (option.hint) wizard.append(make('p', option.hint, 'fine-print'));
      }
      if (step.type === 'multiselect') wizard.append(actionButton('Submit selected options', () => advance(optionInputs.filter(item => item.input.checked).map(item => item.value))));
    } else if (step.type === 'confirm') wizard.append(actionButton('Yes', () => advance(true)), actionButton('No', () => advance(false)));
    else if (step.type === 'note' || step.type === 'action' && step.executor === 'client') wizard.append(actionButton(step.type === 'action' ? 'I completed this native step' : 'Continue', () => advance()));
    else wizard.append(actionButton('Check progress', () => request({ action: 'next', sessionId }, receiveWizard)));
    wizardActions(); sync(); return false;
  }
  function actionButton(label, action) { const button = make('button', label, 'secondary-button'); button.type = 'button'; button.addEventListener('click', action); return button; }
  function wizardActions() {
    wizard.append(actionButton('Check sign-in status', () => request({ action: 'wizard-status', sessionId }, result => terminal(nativeWizardView(result)), { readonly: true })),
      actionButton('Cancel native sign-in', () => request({ action: 'cancel', sessionId }, result => { const next = nativeWizardView(result); if (next.status === 'running') { status.textContent = 'Cancellation requested; native sign-in is still running. Check its status.'; return false; } return terminal({ done: true, status: next.status || 'cancelled' }); })));
  }
  async function refresh() {
    await request(undefined, result => { renderStatus(result); status.textContent = 'Installed native sign-in options loaded. Authentication readiness is not an inference test.'; }, { readonly: true });
  }
  refreshButton.addEventListener('click', refresh);
  saveKey.addEventListener('click', async () => {
    if (busy || isBusy() || sessionId) return;
    if (!providerId(keyProvider.value.trim()) || !keyInput.value || /[\0\r\n]/.test(keyInput.value)) { status.textContent = 'Enter the native provider ID and a new API key.'; passwords(); return; }
    const payload = { action: 'key', provider: keyProvider.value.trim(), apiKey: keyInput.value }; keyInput.value = '';
    await request(payload, () => { status.textContent = 'Credential stored in native OpenClaw. Provider readiness can now be inspected in native models.'; return true; }, { updated: true });
  });
  keyInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); saveKey.click(); } });
  saveConfig.addEventListener('click', async () => {
    if (busy || isBusy() || sessionId) return; let payload;
    try { payload = nativeProviderConfiguration(configProvider.value.trim(), configInput.value); }
    catch (failure) { status.textContent = failure.message; if (failure.code === 'SECRET_IN_NATIVE_CONFIG') configInput.value = '{}'; return; }
    const bound = context(), version = epoch; busy = true; parentLocked = true; onBusy(true); sync();
    try { await api('/api/openclaw/providers', payload); if (bound === context() && version === epoch) status.textContent = 'Native provider configuration saved against the installed schema. Add credentials separately, then inspect native models.'; }
    catch { if (bound === context() && version === epoch) status.textContent = 'The installed native provider schema did not accept this configuration. Inspect Settings and retry.'; }
    finally { if (version === epoch) { busy = false; parentLocked = false; onBusy(false); sync(); } }
    if (bound === context() && version === epoch) { try { await onUpdated(); } catch {} }
  });
  function reset({ cancel = false } = {}) {
    const previous = sessionId, sameOwner = owner === context(), wasBlocking = parentLocked; parentLocked = false; owner = context(); epoch++; busy = false; sessionId = ''; currentStep = null; passwords(); stepInput = null; optionInputs = [];
    wizard.replaceChildren(); options.replaceChildren(); profiles.replaceChildren(); providerIds.replaceChildren(); keyProvider.value = ''; configProvider.value = ''; configInput.value = '{}'; view = nativeAuthStatusView(null); details.open = false;
    status.textContent = 'Provider credentials stay in local OpenClaw. Read installed options to begin.';
    if (wasBlocking) onBusy(false); sync();
    if (cancel && previous && sameOwner) void api('/api/openclaw/auth', { action: 'cancel', sessionId: previous }).catch(() => {});
  }
  details.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target?.tagName?.toLowerCase() === 'input') { event.preventDefault(); event.stopPropagation(); } });
  sync(); return { refresh, reset, sync };
}
