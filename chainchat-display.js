export function supportedBridgeVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) return false;
  const value = version.split(".").map(Number);
  if (!value.every(Number.isSafeInteger)) return false;
  const minimum = [1, 0, 4];
  for (let i = 0; i < minimum.length; i++) {
    if (value[i] > minimum[i]) return true;
    if (value[i] < minimum[i]) return false;
  }
  return true;
}

export function blockHeight(agent, paired = true) {
  if (!paired || !agent) return "\u2014";
  const index = agent.head?.index;
  if (typeof index === "number")
    return Number.isSafeInteger(index) && index >= 0
      ? index.toLocaleString()
      : "\u2014";
  if (typeof index === "string" && /^(0|[1-9][0-9]*)$/.test(index))
    return BigInt(index).toLocaleString();
  return "\u2014";
}

/** Public model metadata only: credentials and unknown response fields are discarded. */
export function modelCatalogueView(value) {
  const text = (item, limit = 1000) => typeof item === 'string' ? item.slice(0, limit) : '';
  const validId = item => typeof item === 'string' && item.length > 0 && item.length <= 256 && !/[\r\n\0]/.test(item);
  const source = Array.isArray(value?.tiers) ? value.tiers.find(item => item?.id === 'byok') : null;
  const seen = new Set();
  const models = (Array.isArray(source?.models) ? source.models : []).slice(0, 1000)
    .filter(item => validId(item?.id) && !seen.has(item.id) && seen.add(item.id)).map(item => ({
      id: item.id, name: text(item.name, 256) || item.id, available: source.available === true && item.available === true,
      reason: text(item.reason), provider: text(item.provider, 128), privacyNotice: text(item.privacyNotice, 2000),
      contextWindow: Number.isSafeInteger(item.contextWindow) && item.contextWindow > 0 ? item.contextWindow : null,
      maxOutputTokens: Number.isSafeInteger(item.maxOutputTokens) && item.maxOutputTokens > 0 ? item.maxOutputTokens : null,
      reasoningCapable: item.reasoningCapable === true,
    }));
  const active = ['byok', 'native'].includes(value?.active?.tier) && validId(value?.active?.model)
    ? { tier: value.active.tier, provider: text(value.active.provider, 128), model: value.active.model } : null;
  return { active, tiers: [{ id: 'byok', available: source?.available === true, notice: text(source?.notice, 2000), models }] };
}

/** Older installed runtimes may still report a retired model source. */
export function providerConnectionView(provider) {
  if (!provider || provider.tier && !['byok', 'native'].includes(provider.tier)) return { configured: false };
  return provider;
}

export function modelSwitchPayload(catalogue, model) {
  const { tiers: [connection] } = modelCatalogueView(catalogue);
  if (!connection.available) throw new Error('Connect your API provider before switching models with its existing key.');
  if (model === undefined) return { tier: 'byok' };
  const id = typeof model === 'string' ? model.trim() : '';
  if (!id || id.length > 256 || /[\r\n\0]/.test(id)) throw new Error('Enter an exact model ID from your provider.');
  return { tier: 'byok', model: id };
}
