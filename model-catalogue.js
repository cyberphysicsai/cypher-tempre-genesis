/** Catalogue actions contain public model IDs and fixed presets, never API keys. */
export function modelChoiceAction(model, tier) {
  if (!model || model.available !== true || !['free', 'byok'].includes(tier) ||
      typeof model.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.id))
    throw new Error('Refresh the catalogue and choose an available model.');
  if (tier === 'free' && model.access === 'byok') {
    if (model.service !== 'openrouter') throw new Error('This model requires a supported private provider connection.');
    if (model.connectionReady === true) return { kind: 'switch', tier: 'byok', model: model.id };
    return { kind: 'connect', preset: { provider: 'compatible', baseUrl: 'https://openrouter.ai/api/v1', model: model.id,
      reasoningCapable: model.reasoningCapable === true } };
  }
  return { kind: 'switch', tier, model: model.id };
}


export function nativeModelCatalogueView(value) {
  const valid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id);
  const seen = new Set(), text = (value, max = 1000) => typeof value === 'string' ? value.slice(0, max) : '';
  return { configured: value?.configured === true, current: valid(value?.current) ? value.current : '',
    notice: text(value?.notice), models: (Array.isArray(value?.models) ? value.models : []).slice(0, 1000)
      .filter(model => valid(model?.id) && !seen.has(model.id) && seen.add(model.id)).map(model => ({ id: model.id,
        name: text(model.name, 200) || model.id, available: model.available === true, reason: text(model.reason) })) };
}
export function nativeModelSelection(value, requested) {
  const provider = value?.provider;
  if (provider?.provider !== 'native' || provider.tier !== 'native' || provider.configured !== true || provider.model !== requested)
    throw new Error('The local app did not confirm the selected native OpenClaw model.');
  return { provider: 'native', tier: 'native', model: requested, configured: true };
}
export function mountNativeModelPicker({ document: doc, mount, api, onSelected, onBusy = () => {}, isBusy = () => false,
  context = () => '', activeModel = () => '' }) {
  const make = (tag, text = '', className = '') => { const node = doc.createElement(tag); node.textContent = text; node.className = className; return node; };
  const open = make('button', 'Use native OpenClaw model', 'secondary-button full-width'); open.type = 'button';
  const note = make('p', 'Use models and credentials already configured in your local OpenClaw. Configure missing authentication in OpenClaw first.', 'fine-print');
  const panel = make('div', '', 'hidden'), status = make('p', '', 'fine-print'); status.setAttribute('role', 'status');
  panel.id = 'nativeModelCatalogue'; open.setAttribute('aria-controls', panel.id); open.setAttribute('aria-expanded', 'false');
  const list = make('div', '', 'model-catalogue-list'), refresh = make('button', 'Refresh native models', 'text-button'); refresh.type = 'button';
  panel.append(status, list, refresh); mount.append(open, note, panel);
  let view = nativeModelCatalogueView(null), busy = false, loading = false, epoch = 0, boundContext = context();
  function sync() {
    if (boundContext !== context()) { reset(); return; }
    const locked = busy || loading || isBusy(); open.disabled = locked; refresh.disabled = locked; list.replaceChildren();
    note.textContent = activeModel() ? `Native OpenClaw model active: ${String(activeModel()).slice(0, 256)}. Its credentials stay in local OpenClaw.`
      : 'Use models and credentials already configured in your local OpenClaw. Configure missing authentication in OpenClaw first.';
    for (const model of view.models) {
      const button = make('button', '', 'model-choice'); button.type = 'button'; button.disabled = locked || !model.available;
      const heading = make('span', '', 'model-choice-heading');
      heading.append(make('strong', model.name), make('small', activeModel() === model.id ? 'ACTIVE' : !model.available ? 'UNAVAILABLE' : view.current === model.id ? 'DEFAULT · USE' : 'USE'));
      button.append(heading, make('span', model.id, 'model-choice-id'));
      if (!model.available) button.append(make('span', model.reason || 'Configure authentication for this model in local OpenClaw.', 'model-choice-reason'));
      button.addEventListener('click', () => select(model)); list.append(button);
    }
    if (!view.models.length && !loading) list.append(make('p', 'No eligible configured native models are currently listed.', 'fine-print'));
  }
  async function load() {
    if (busy || loading || isBusy()) return;
    const owner = context(), version = ++epoch; loading = true; panel.classList.remove('hidden'); open.setAttribute('aria-expanded', 'true'); status.textContent = 'Reading the local OpenClaw model configuration…'; sync();
    try {
      const result = await api('/api/openclaw/provider');
      if (owner !== context() || version !== epoch) return;
      view = nativeModelCatalogueView(result); status.textContent = view.notice || 'Choose an available model configured in local OpenClaw. Provider credentials stay in the native runtime.';
    } catch { if (owner === context() && version === epoch) { view = nativeModelCatalogueView(null); status.textContent = 'Native model settings are unavailable. Open the installed app and configure OpenClaw locally.'; } }
    finally { if (owner === context() && version === epoch) { loading = false; sync(); } }
  }
  async function select(model) {
    if (busy || loading || isBusy() || model.available !== true) return;
    const owner = context(), version = ++epoch; busy = true; onBusy(true); sync(); status.textContent = 'Selecting the configured native model…';
    try {
      const result = await api('/api/openclaw/provider', { model: model.id });
      if (owner !== context() || version !== epoch) return;
      const provider = nativeModelSelection(result, model.id); await onSelected(provider);
      view.current = provider.model; status.textContent = 'Native OpenClaw model selected. Its credentials remain local.';
    } catch { if (owner === context() && version === epoch) status.textContent = 'The native model could not be selected. Check its local OpenClaw configuration and try again.'; }
    finally { if (version === epoch) { busy = false; onBusy(false); sync(); } }
  }
  function reset() {
    boundContext = context(); epoch++; loading = false; const wasBusy = busy; busy = false;
    view = nativeModelCatalogueView(null); panel.classList.add('hidden'); open.setAttribute('aria-expanded', 'false'); status.textContent = '';
    if (wasBusy) onBusy(false); sync();
  }
  open.addEventListener('click', load); refresh.addEventListener('click', load);
  return { sync, reset, refresh: load };
}
