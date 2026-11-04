// Facts from the current private host invocation. These never confer authority.
export const OWN_SESSION_REVIEW_TOOLS = Object.freeze(['get_goal', 'update_goal']);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) && !/[\r\n\u2028\u2029]/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => Object.assign(new Error('The verified host process context is invalid.'), { code: 'GATE_INVALID_AGENT_CONTEXT', status: 422 });
const name = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 128 &&
  !/[\0\r\n\u2028\u2029]/.test(value) && /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(value);
const names = value => Array.isArray(value) && value.length <= 128 && new Set(value).size === value.length && [...value].every(name);
const states = new Set(['computed/completed/base-op', 'computed/completed/recipe', 'computed/completed/authored-code',
  'frame/completed/lens', 'frame/completed/routing-hint', 'unsupported/failed/authored-code',
  'unsupported/unavailable/definition', 'quarantined/unavailable/authored-code']);

/** Validate only a narrow factual projection, never raw permissions or code. */
export function validateHostProcessContext(value, identity) {
  if (value == null) return null;
  if (!exact(value, ['version', 'genesisHash', 'preparationHeadHash', 'faculties', 'toolScope', 'releaseReview']) ||
      value.version !== 1 || !hex(value.genesisHash) || value.genesisHash !== identity?.genesisHash || !hex(value.preparationHeadHash) ||
      !exact(value.toolScope, ['external', 'ownSession']) || !names(value.toolScope.external) || !names(value.toolScope.ownSession) ||
      value.toolScope.external.some(tool => OWN_SESSION_REVIEW_TOOLS.includes(tool)) ||
      value.toolScope.ownSession.some(tool => !OWN_SESSION_REVIEW_TOOLS.includes(tool)) ||
      !exact(value.releaseReview, ['semantic', 'native']) || value.releaseReview.semantic !== true || value.releaseReview.native !== true)
    throw invalid();
  if (value.faculties !== null) {
    const equipped = identity?.equippedFaculties;
    if (!Array.isArray(equipped) || !Array.isArray(value.faculties) || value.faculties.length > 2048 ||
        value.faculties.length !== equipped.length || new Set(value.faculties.map(item => item?.key)).size !== value.faculties.length)
      throw invalid();
    const keys = new Set(equipped.map(item => item.key));
    if ([...value.faculties].some(item => !exact(item, ['key', 'mode', 'status', 'mechanism']) || !keys.has(item.key) ||
        !['mode', 'status', 'mechanism'].every(field => typeof item[field] === 'string') ||
        !states.has([item.mode, item.status, item.mechanism].join('/')))) throw invalid();
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 128 * 1024) throw invalid();
  return structuredClone(value);
}

/** Call only with an actual prepared result and private, validated authority.
 * Missing legacy receipts remain unknown; labels/computed prose cannot invent them. */
export function projectHostProcessContext(prepared, { active = false, externalTools = [], ownSessionTools = [],
  expectedHead, expectedGenesis } = {}) {
  if (active !== true || prepared?.runtime?.mode !== 'active') return null;
  const identity = prepared.trustedAgentContext;
  if (!identity?.genesisHash || !prepared.head?.hash) return null;
  if (prepared.genesis?.hash !== identity.genesisHash || !hex(prepared.head.hash) ||
      expectedHead !== undefined && expectedHead !== prepared.head.hash ||
      expectedGenesis !== undefined && expectedGenesis !== identity.genesisHash) throw invalid();
  if (!names(externalTools) || !names(ownSessionTools)) throw invalid();
  let faculties = null;
  if (prepared.facultyExecution !== undefined && Array.isArray(identity.equippedFaculties)) {
    const receipt = prepared.facultyExecution;
    if (!exact(receipt, ['scope', 'entries']) || receipt.scope !== 'turn' || !Array.isArray(receipt.entries) || receipt.entries.length > 2048) throw invalid();
    const equipped = new Map(identity.equippedFaculties.map(item => [item.key, item]));
    faculties = receipt.entries.map(row => {
      const current = row && equipped.get(row.key);
      if (!current || row.kind !== current.kind || row.name !== current.name) throw invalid();
      return { key: row.key, mode: row.mode, status: row.status, mechanism: row.mechanism };
    });
  }
  return validateHostProcessContext({ version: 1, genesisHash: identity.genesisHash, preparationHeadHash: prepared.head.hash,
    faculties, toolScope: { external: [...externalTools].sort(), ownSession: [...ownSessionTools].sort() },
    releaseReview: { semantic: true, native: true } }, identity);
}
