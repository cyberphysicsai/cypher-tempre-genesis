// Manage API keys in the private local OpenClaw store.
const text = (value, maximum = 2000) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, maximum) : '';
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
const providerId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) && !value.startsWith('chainchat-');
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

export function nativeAuthStatusView(value) {
  const capabilities = [...new Set((Array.isArray(value?.providerCapabilities) ? value.providerCapabilities : [])
    .slice(0, 512).filter(row => providerId(row?.provider) && row.apiKeySupported === true).map(row => row.provider))];
  const providers = [];
  for (const row of (Array.isArray(value?.providers) ? value.providers : []).slice(0, 512)) {
    if (!providerId(row?.provider)) continue;
    const profiles = (Array.isArray(row.profiles) ? row.profiles : []).slice(0, 64)
      .filter(profile => profile?.type === 'api_key' && opaque(profile.profileId)).map(profile => ({
        id: profile.profileId, name: text(profile.displayName, 200) || profile.profileId,
        status: text(profile.status, 80), logoutSupported: profile.logoutSupported === true,
      }));
    if (profiles.length || capabilities.includes(row.provider)) providers.push({
      provider: row.provider, name: text(row.displayName, 200) || row.provider, profiles,
    });
  }
  return { providers, capabilities, available: value?.available !== false && (providers.length > 0 || capabilities.length > 0) };
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
  onBusy = () => {}, onUpdated = async () => {}, openSettings = () => {} }) {
  const make = (tag, content = '', className = '') => { const node = doc.createElement(tag); node.textContent = content; node.className = className; return node; };
  const details = make('details', '', 'native-auth'), summary = make('summary', 'Native API keys & configuration');
  const refreshButton = make('button', 'Read native API key status', 'secondary-button'); refreshButton.type = 'button';
  const privateKeys = 'Native OpenClaw stores its API keys privately on this computer.';
  const status = make('p', privateKeys, 'fine-print'); status.setAttribute('role', 'status');
  const profiles = make('div', '', 'native-auth-profiles');
  const keyProviderLabel = make('label', 'Native provider ID', 'field'), keyProvider = make('input'); keyProvider.type = 'text'; keyProvider.autocomplete = 'off'; keyProvider.maxLength = 64; keyProvider.setAttribute('list', 'nativeAuthProviderIds'); keyProviderLabel.append(keyProvider);
  const providerIds = make('datalist'); providerIds.id = 'nativeAuthProviderIds';
  const keyLabel = make('label', 'New native API key', 'field'), keyInput = make('input'); keyInput.type = 'password'; keyInput.autocomplete = 'new-password'; keyInput.spellcheck = false; keyInput.maxLength = 16384; keyLabel.append(keyInput);
  const saveKey = make('button', 'Store key in native OpenClaw', 'secondary-button'); saveKey.type = 'button';
  const keyFields = make('div', '', 'native-auth-key'); keyFields.append(keyProviderLabel, keyLabel, providerIds, saveKey);
  const advanced = make('details', '', 'native-auth-configuration'); advanced.append(make('summary', 'Custom native provider · nonsecret JSON'));
  const configProviderLabel = make('label', 'Custom provider ID', 'field'), configProvider = make('input'); configProvider.type = 'text'; configProvider.maxLength = 64; configProvider.autocomplete = 'off'; configProviderLabel.append(configProvider);
  const configLabel = make('label', 'Configuration validated against OpenClaw’s provider schema', 'field'), configInput = make('textarea'); configInput.rows = 7; configInput.value = '{}'; configInput.spellcheck = false; configInput.maxLength = 262144; configLabel.append(configInput);
  const schemaButton = make('button', 'Inspect the native schema in Settings', 'text-button'); schemaButton.type = 'button'; schemaButton.addEventListener('click', openSettings);
  const saveConfig = make('button', 'Validate & save native provider', 'secondary-button'); saveConfig.type = 'button';
  advanced.append(make('p', 'Use the installed provider schema. Enter API keys in the native credential field above.', 'fine-print'), schemaButton, configProviderLabel, configLabel, saveConfig);
  details.append(summary, refreshButton, status, profiles, keyFields, advanced); mount.append(details);

  let owner = context(), epoch = 0, busy = false, parentLocked = false;
  function sync() {
    if (owner !== context()) { reset(); return; }
    const locked = busy || isBusy();
    for (const button of details.querySelectorAll('button')) button.disabled = locked;
    keyProvider.disabled = keyInput.disabled = configProvider.disabled = configInput.disabled = locked;
  }
  async function request(route, payload, consume, { failure, updated = false } = {}) {
    if (busy || isBusy()) return;
    const version = epoch, bound = context(); busy = true;
    if (updated) { parentLocked = true; onBusy(true); }
    sync();
    let completed = false;
    try {
      const result = await api(route, payload);
      if (bound !== context() || version !== epoch) return;
      consume(result); completed = true;
    } catch {
      if (bound === context() && version === epoch) status.textContent = failure;
    } finally {
      if (payload?.apiKey) payload.apiKey = '';
      if (version === epoch) {
        busy = false;
        if (updated) { parentLocked = false; onBusy(false); }
        sync();
      }
    }
    if (completed && updated && bound === context() && version === epoch) {
      try { await onUpdated(); }
      catch { if (bound === context() && version === epoch) status.textContent += ' Refresh native models to update the list.'; }
    }
  }
  function renderStatus(raw) {
    const view = nativeAuthStatusView(raw);
    profiles.replaceChildren(); providerIds.replaceChildren();
    for (const provider of view.capabilities) {
      const option = make('option'); option.value = provider; providerIds.append(option);
    }
    for (const provider of view.providers) {
      if (!provider.profiles.length) continue;
      const row = make('article', '', 'native-auth-provider');
      row.append(make('h4', provider.name));
      for (const profile of provider.profiles) {
        row.append(make('p', [profile.name, profile.status].filter(Boolean).join(' · '), 'fine-print'));
        if (profile.logoutSupported) {
          const remove = make('button', 'Remove saved key · ' + profile.name, 'text-button'); remove.type = 'button'; row.append(remove);
          remove.addEventListener('click', () => request('/api/openclaw/auth', { action: 'logout', provider: provider.provider, profileIds: [profile.id] },
            () => { status.textContent = 'Saved key removal completed. Read native API key status to refresh this list.'; },
            { updated: true, failure: 'The saved API key could not be removed. Check native settings and try again.' }));
        }
      }
      profiles.append(row);
    }
    status.textContent = view.available ? 'Native API key status loaded. Send a message to test provider access.'
      : 'No API key status is available from the installed runtime. You can enter a provider ID and key below.';
  }
  const refresh = () => request('/api/openclaw/auth', undefined, renderStatus, { failure: 'The local runtime could not report native API key status.' });
  refreshButton.addEventListener('click', refresh);
  saveKey.addEventListener('click', async () => {
    if (busy || isBusy()) return;
    const provider = keyProvider.value.trim(), apiKey = keyInput.value;
    keyInput.value = '';
    if (!providerId(provider) || !apiKey || /[\0\r\n]/.test(apiKey)) { status.textContent = 'Enter the native provider ID and a new API key.'; return; }
    await request('/api/openclaw/auth', { action: 'key', provider, apiKey },
      () => { status.textContent = 'API key stored in local OpenClaw. Choose a model to test provider access.'; },
      { updated: true, failure: 'The API key could not be stored. Check the provider ID and try again.' });
  });
  keyInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); saveKey.click(); }
  });
  saveConfig.addEventListener('click', async () => {
    if (busy || isBusy()) return;
    let payload;
    try { payload = nativeProviderConfiguration(configProvider.value.trim(), configInput.value); }
    catch (error) { status.textContent = error.message; if (error.code === 'SECRET_IN_NATIVE_CONFIG') configInput.value = '{}'; return; }
    await request('/api/openclaw/providers', payload,
      () => { status.textContent = 'Native provider configuration saved. Add its API key, then choose a model.'; },
      { updated: true, failure: 'The installed native provider schema did not accept this configuration. Inspect Settings and retry.' });
  });
  function reset() {
    const wasBlocking = parentLocked; parentLocked = false; owner = context(); epoch++; busy = false;
    profiles.replaceChildren(); providerIds.replaceChildren(); keyProvider.value = ''; keyInput.value = '';
    configProvider.value = ''; configInput.value = '{}'; details.open = false; status.textContent = privateKeys;
    if (wasBlocking) onBusy(false);
    sync();
  }
  details.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target?.tagName?.toLowerCase() === 'input') { event.preventDefault(); event.stopPropagation(); }
  });
  sync(); return { refresh, reset, sync };
}
