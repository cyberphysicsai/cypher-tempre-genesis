import { randomUUID } from 'node:crypto';
import { validateProvider, assertCredentialIsolation } from './providers.mjs';
import { sanitizeModelText } from './terminology.mjs';

export const FREE_MODEL_ENDPOINT = 'https://cyphertempre.ai/api/free-models.php';
export const FREE_MODEL_BASE_URL = 'https://cyphertempre.ai/api/free-model/v1';
export const FREE_MODEL_MARKER = 'chainchat-free-tier';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const fail = (message, code = 'MODEL_UNAVAILABLE', status = 409) => Object.assign(new Error(message), { code, status });
const label = (value, fallback = '', maximum = 500) => typeof value === 'string'
  ? sanitizeModelText(value).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, maximum) : fallback;
const limit = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;

function entry(raw, provider, { current = false, free = false } = {}) {
  const id = typeof (raw?.id ?? raw?.name) === 'string' ? (raw.id ?? raw.name).trim() : '';
  if (!ID.test(id)) return null;
  const contextWindow = limit(raw.contextWindow ?? raw.context_window ?? raw.context_length ?? raw.inputTokenLimit ?? raw.limit?.context ?? raw.limits?.context, 4096, 2097152);
  const rawOutput = raw.maxOutputTokens ?? raw.max_output_tokens ?? raw.outputTokenLimit ?? raw.limit?.output ?? raw.limits?.output;
  const output = Number.isSafeInteger(rawOutput) && rawOutput >= 128 ? Math.min(rawOutput, 32768) : null;
  return { id, name: label(raw.display_name ?? raw.displayName ?? raw.displayNameText ?? raw.name, id, 160) || id,
    available: free ? raw.available === true : raw.available !== false,
    reason: label(raw.reason, ''), provider,
    contextWindow, maxOutputTokens: output !== null && (contextWindow === null || output < contextWindow) ? output : null,
    reasoningCapable: raw.reasoningCapable === true || raw.reasoning === true || raw.capabilities?.reasoning === true || raw.capabilities?.reasoning?.supported === true,
    reasoningDeclared: typeof raw.reasoningCapable === 'boolean' || typeof raw.reasoning === 'boolean' ||
      typeof raw.capabilities?.reasoning === 'boolean' || typeof raw.capabilities?.reasoning?.supported === 'boolean',
    privacyNotice: label(raw.privacyNotice, free
      ? 'Free requests and relevant chain context pass through the Cypher Tempre relay to its configured model provider.'
      : 'Requests and relevant chain context are sent to your configured model provider.'),
    ...(current ? { current: true } : {}) };
}

function openCodeRoute(config, raw) {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' || base.hostname !== 'opencode.ai' || base.port || !/^\/inference\//.test(base.pathname)) return null;
  const prefix = base.pathname.startsWith('/inference/go/') ? '/inference/go' : '/inference';
  const families = [ ['responses', 'openai', '/openai/v1'], ['chat-completions', 'compatible', '/openai/v1'],
    ['messages', 'anthropic', '/anthropic/v1'], ['generate-content', 'gemini', '/google/v1beta'] ];
  for (const [family, provider, suffix] of families) {
    const expected = 'https://opencode.ai' + prefix + suffix;
    if (raw.api?.[family]?.base_url === expected) return { provider, baseUrl: expected };
  }
  return false; // Known origin, but no supported, exact same-service route.
}

function source(config) {
  const base = new URL(config.baseUrl), headers = { accept: 'application/json' };
  const openCode = base.protocol === 'https:' && base.hostname === 'opencode.ai' && !base.port && /^\/inference\//.test(base.pathname);
  let url;
  if (openCode) {
    const go = base.pathname.startsWith('/inference/go/');
    url = new URL(go ? '/inference/go/v1/models' : '/inference/v1/models', base.origin).href;
    if (go) { headers['user-agent'] = 'CypherTempre-ChainChat'; headers['x-opencode-session'] = randomUUID(); }
  } else {
    url = config.baseUrl.replace(/\/+$/, '') + '/models';
    if (config.apiKey) headers[config.provider === 'anthropic' ? 'x-api-key' : config.provider === 'gemini' ? 'x-goog-api-key' : 'authorization'] =
      ['anthropic', 'gemini'].includes(config.provider) ? config.apiKey : 'Bearer ' + config.apiKey;
    if (config.provider === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  }
  return { url, headers };
}

async function boundedJSON(fetchImpl, url, headers) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
    if (!response.ok || response.redirected) throw fail('The model catalogue could not be loaded.', 'MODEL_CATALOGUE_UNAVAILABLE', 503);
    const claimed = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(claimed) && claimed > 1024 * 1024) throw fail('The model catalogue exceeds its limit.');
    if (!response.body?.getReader) throw fail('The model catalogue has no bounded response body.');
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 1024 * 1024) throw fail('The model catalogue exceeds its limit.');
        chunks.push(Buffer.from(value));
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); }
}

export function createModelCatalogue({ fetchImpl = globalThis.fetch, freeModelEndpoint = FREE_MODEL_ENDPOINT,
  freeModelBaseUrl = FREE_MODEL_BASE_URL, now = Date.now } = {}) {
  // Endpoint injection belongs to the application constructor, never an HTTP input.
  const testRelay = validateProvider({ provider: 'compatible', model: 'relay-route', baseUrl: freeModelBaseUrl, apiKey: FREE_MODEL_MARKER });
  const catalogueUrl = new URL(freeModelEndpoint);
  if (catalogueUrl.username || catalogueUrl.password || catalogueUrl.search || catalogueUrl.hash ||
      catalogueUrl.protocol !== 'https:' && !(catalogueUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(catalogueUrl.hostname)))
    throw new TypeError('A trusted fixed model catalogue URL is required.');
  let freeCache = null;
  const byokRoutes = new WeakMap();
  // Effective model limits are not user preferences. Keep the original ceilings
  // private so visiting a smaller model cannot permanently shrink later models.
  const byokLimits = new WeakMap();
  async function freeTier({ refresh = false } = {}) {
    if (!refresh && freeCache && freeCache.expires > now()) return structuredClone(freeCache.tier);
    let tier;
    try {
      const raw = await boundedJSON(fetchImpl, catalogueUrl.href, { accept: 'application/json' });
      const verified = raw?.freeOnly === true && Array.isArray(raw.models) ? raw.models.slice(0, 200).filter(model =>
        model && model.free === true && model.pricing?.input === 0 && model.pricing?.output === 0) : [];
      const models = verified.map(model => entry(model, 'compatible', { free: true })).filter(Boolean);
      tier = { id: 'free', label: 'Free models', available: raw?.available === true && models.some(model => model.available),
        notice: label(raw?.notice, 'Free access is unavailable. You can connect your own provider.'),
        models: raw?.available === true ? models : models.map(model => ({ ...model, available: false,
          reason: model.reason || 'The free relay is unavailable.' })) };
    } catch { tier = { id: 'free', label: 'Free models', available: false,
      notice: 'Free access is temporarily unavailable. You can connect your own provider.', models: [] }; }
    freeCache = { expires: now() + 15000, tier };
    return structuredClone(tier);
  }
  async function byokTier(config) {
    if (!config) return { id: 'byok', label: 'Bring your own key', available: false,
      notice: 'Connect your provider and API key. You can enter a model ID manually.', models: [] };
    const normalized = validateProvider(config), current = entry({ ...normalized, id: normalized.model, name: normalized.model }, normalized.provider, { current: true });
    let models = [], notice = 'Models from your configured provider. A custom model ID is also supported.';
    try {
      const route = source(normalized), raw = await boundedJSON(fetchImpl, route.url, route.headers);
      assertCredentialIsolation(normalized, raw);
      const records = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : [];
      const routes = new Map();
      models = records.slice(0, 500).filter(model => (!model.type || model.type === 'chat') &&
        (normalized.provider !== 'gemini' || !Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes('generateContent')))
        .map(model => {
          const route = openCodeRoute(normalized, model), row = entry(model, route?.provider || normalized.provider);
          if (!row) return null;
          if (route === false) { row.available = false; row.reason = 'This model has no supported API route at the configured OpenCode service.'; }
          else if (route) routes.set(row.id, route);
          return row;
        }).filter(Boolean);
      byokRoutes.set(config, routes);
      if (!models.length) notice = 'This provider did not list chat models. Enter its exact model ID manually.';
    } catch { byokRoutes.delete(config); notice = 'The provider catalogue is unavailable. Your configured model and manual model IDs remain available.'; }
    const unique = new Map(models.map(model => [model.id, model]));
    if (!unique.has(current.id)) unique.set(current.id, current);
    return { id: 'byok', label: 'Bring your own key', available: true, notice, models: [...unique.values()] };
  }
  return Object.freeze({ freeTier, byokTier,
    async describe({ byok = null, active = null, refresh = false } = {}) {
      const tiers = await Promise.all([byokTier(byok), freeTier({ refresh })]);
      return { active: { tier: active?.tier === 'free' ? 'free' : 'byok', provider: active?.provider || null, model: active?.model || null }, tiers };
    },
    async selectFree(model) {
      const tier = await freeTier({ refresh: true });
      const selected = tier.models.find(row => row.id === model && row.available);
      if (!tier.available || !selected) throw fail('Choose an available zero-cost model from the free catalogue.');
      return { ...validateProvider({ ...testRelay, model: selected.id,
        ...(selected.reasoningCapable ? { reasoningCapable: true } : {}),
        ...(selected.contextWindow !== null ? { contextWindow: selected.contextWindow } : {}),
        ...(selected.maxOutputTokens !== null ? { maxOutputTokens: selected.maxOutputTokens } : {}) }), tier: 'free' };
    },
    async selectByok(config, model) {
      if (!config) throw fail('Connect your own provider and API key first.', 'PROVIDER_REQUIRED');
      const tier = await byokTier(config), id = model ?? config.model;
      const selected = tier.models.find(row => row.id === id);
      if (selected?.available === false) throw fail('This model is unavailable at the configured provider.');
      const route = byokRoutes.get(config)?.get(id);
      const preferences = byokLimits.get(config) || {
        contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens,
      };
      // An unknown manual ID has no verified larger budget. Keep the active
      // limits until advertised metadata establishes that a change is safe.
      const limits = selected && !selected.current ? preferences : config;
      const reasoningCapable = selected?.reasoningDeclared ? selected.reasoningCapable : config.reasoningCapable === true;
      const contextWindow = selected?.contextWindow && (limits.contextWindow || selected.contextWindow < 131072)
        ? Math.min(limits.contextWindow ?? 131072, selected.contextWindow) : limits.contextWindow;
      const requestedOutput = limits.maxOutputTokens ?? (reasoningCapable ? 8192 : 4096);
      const maxOutputTokens = Math.min(requestedOutput, selected?.maxOutputTokens ?? requestedOutput, contextWindow ? contextWindow - 1 : 32768);
      const { maxOutputTokens: previousOutput, contextWindow: previousContext, ...base } = config;
      const result = { ...validateProvider({ ...base, ...(route || {}), model: id, reasoningCapable,
        ...(contextWindow ? { contextWindow } : {}),
        ...(limits.maxOutputTokens !== undefined || selected?.maxOutputTokens != null || maxOutputTokens < requestedOutput ? { maxOutputTokens } : {}) }), tier: 'byok' };
      byokLimits.set(result, preferences);
      return result;
    } });
}
