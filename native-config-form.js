// Dependency-free controls over the exact native config.schema response.
// The local runtime remains the authoritative schema/policy validator.
const badKeys = new Set(['__proto__', 'prototype', 'constructor']);
const text = (value, limit = 4000) => typeof value === 'string' ? value.slice(0, limit) : '';
const own = (value, key) => value != null && Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = path => JSON.stringify(path);
const secretKey = key => /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|app[_-]?token|client[_-]?secret|signing[_-]?secret|token|secret|password|passphrase|authorization|private[_-]?key|credential)$/i.test(key);
const redacted = value => typeof value === 'string' && /^(?:__OPENCLAW_REDACTED__|__CHAINCHAT_[A-Z_]+__|\[REDACTED\])$/i.test(value);
const invalid = message => Object.assign(new Error(message), { code: 'NATIVE_CONFIG_FORM_INVALID' });

export function nativeConfigValue(value) {
  let count = 0;
  function copy(item, depth = 0) {
    if (++count > 50000 || depth > 40) throw invalid('This value exceeds the local configuration editor bounds.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (item.length > 1048576) throw invalid('This text exceeds the local configuration editor bounds.');
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(entry => copy(entry, depth + 1));
    if (!object(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw invalid('Use a JSON configuration value.');
    const out = {};
    for (const [key, entry] of Object.entries(item)) {
      if (badKeys.has(key)) throw invalid('Reserved object keys cannot be edited.');
      out[key] = copy(entry, depth + 1);
    }
    return out;
  }
  return copy(value);
}
const pathValue = (root, path) => path.reduce((value, key) => own(value, key) ? value[key] : undefined, root);
function safePath(path) {
  if (!Array.isArray(path) || !path.length || path.length > 40 || path.some(key => typeof key !== 'string' || !key || badKeys.has(key)))
    throw invalid('Choose an exact native setting path.');
  return path;
}
function setPath(root, path, value) {
  let current = root;
  for (const key of path.slice(0, -1)) { if (!object(current[key])) current[key] = {}; current = current[key]; }
  current[path.at(-1)] = value;
}
function deletePath(root, path) {
  let current = root;
  for (const key of path.slice(0, -1)) { if (!object(current[key])) return; current = current[key]; }
  delete current[path.at(-1)];
}
function merge(left, right) {
  const out = object(left) ? nativeConfigValue(left) : {};
  for (const [key, value] of Object.entries(object(right) ? right : {})) out[key] = object(value) && object(out[key]) ? merge(out[key], value) : nativeConfigValue(value);
  return out;
}
const prefix = (left, right) => left.length <= right.length && left.every((part, index) => part === '*' || part === right[index]);
function hintFor(path, hints) {
  const exact = hints?.[path.join('.')];
  if (object(exact)) return exact;
  let best = {}, length = -1;
  for (const [key, value] of Object.entries(hints || {})) {
    const parts = key.split('.');
    if (object(value) && parts.length === path.length && prefix(parts, path) && parts.filter(part => part !== '*').length > length) {
      best = value; length = parts.filter(part => part !== '*').length;
    }
  }
  return best;
}
function sensitive(path, hints) {
  return path.some(secretKey) || path.some((_part, index) => hintFor(path.slice(0, index + 1), hints).sensitive === true);
}
function managed(path, guards, includeChildren = false, guardFor) {
  if (typeof guardFor === 'function') return text(guardFor([...path], { includeChildren }));
  for (const [key, reason] of Object.entries(guards || {})) {
    const guarded = key.split('.');
    if (prefix(guarded, path) || includeChildren && prefix(path, guarded)) return text(reason) || 'Managed by the local runtime.';
  }
  return '';
}
function localReference(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let result = root;
  for (const encoded of ref.slice(2).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (badKeys.has(key) || !own(result, key)) return null;
    result = result[key];
  }
  return object(result) ? result : null;
}
function combineSchema(left, right) {
  const out = { ...left, ...right };
  if (left.properties || right.properties) {
    out.properties = { ...(left.properties || {}) };
    for (const [key, value] of Object.entries(right.properties || {})) out.properties[key] = own(out.properties, key) ? combineSchema(out.properties[key], value) : value;
  }
  if (left.required || right.required) out.required = [...new Set([...(left.required || []), ...(right.required || [])])];
  if (left.additionalProperties === false || right.additionalProperties === false) out.additionalProperties = false;
  if (left.type && right.type && JSON.stringify(left.type) !== JSON.stringify(right.type)) out.__complex = true;
  return out;
}
export function resolveNativeConfigSchema(schema, root, references = new Set()) {
  if (!object(schema)) return {};
  let result = { ...schema };
  if (typeof schema.$ref === 'string') {
    if (references.has(schema.$ref)) return { ...schema, __complex: true };
    const source = localReference(schema.$ref, root);
    if (!source) return { ...schema, __complex: true };
    const next = new Set(references); next.add(schema.$ref);
    result = combineSchema(resolveNativeConfigSchema(source, root, next), Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref')));
  }
  if (Array.isArray(result.allOf)) {
    const branches = result.allOf; delete result.allOf;
    for (const branch of branches) result = combineSchema(result, resolveNativeConfigSchema(branch, root, references));
  }
  return result;
}
function types(schema) {
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type)) return schema.type;
  if (schema.properties || schema.additionalProperties) return ['object'];
  if (schema.items) return ['array'];
  if (own(schema, 'const')) return [schema.const === null ? 'null' : Array.isArray(schema.const) ? 'array' : typeof schema.const];
  return [];
}
function matchesType(schema, value) {
  if (own(schema, 'const')) return JSON.stringify(schema.const) === JSON.stringify(value);
  if (Array.isArray(schema.enum)) return schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value));
  const choices = types(schema);
  const compatible = !choices.length || choices.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? object(value) : type === 'integer' ? Number.isInteger(value) : typeof value === type);
  if (!compatible) return false;
  if (object(value) && object(schema.properties)) {
    if (Array.isArray(schema.required) && schema.required.some(key => !own(value, key))) return false;
    for (const [key, child] of Object.entries(schema.properties)) if (own(value, key) && object(child) && (own(child, 'const') || Array.isArray(child.enum)) && !matchesType(child, value[key])) return false;
  }
  return true;
}
function variants(schema, root) {
  const choices = schema.oneOf || schema.anyOf;
  if (!Array.isArray(choices)) return [];
  const base = Object.fromEntries(Object.entries(schema).filter(([key]) => !['oneOf', 'anyOf'].includes(key)));
  return choices.map(branch => combineSchema(base, resolveNativeConfigSchema(branch, root)));
}
function schemaSensitive(path, envelope) {
  const root = envelope?.schema || envelope || {};
  function expand(raw, references = new Set(), objects = new Set()) {
    if (!object(raw) || objects.has(raw)) return [];
    const visited = new Set(objects); visited.add(raw);
    const result = [raw];
    if (typeof raw.$ref === 'string' && !references.has(raw.$ref)) {
      const source = localReference(raw.$ref, root), next = new Set(references); next.add(raw.$ref);
      if (source) result.push(...expand(source, next, visited));
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(raw[key]))
      for (const branch of raw[key]) result.push(...expand(branch, new Set(references), visited));
    return result;
  }
  let nodes = [root];
  for (let index = 0; index <= path.length; index++) {
    const expanded = nodes.flatMap(raw => expand(raw));
    if (expanded.some(node => node.sensitive === true || node.writeOnly === true || node.format === 'password')) return true;
    if (index === path.length) return false;
    const key = path[index]; nodes = expanded.flatMap(node => {
      const children = [];
      if (own(node.properties, key)) children.push(node.properties[key]);
      for (const [pattern, child] of Object.entries(node.patternProperties || {})) {
        try { if (pattern.length <= 1024 && new RegExp(pattern, 'u').test(key)) children.push(child); } catch { /* Match the native inspector: malformed patterns are ignored. */ }
      }
      if (/^\d+$/.test(key) && node.items) children.push(Array.isArray(node.items) ? node.items[Number(key)] : node.items);
      if (!children.length && object(node.additionalProperties)) children.push(node.additionalProperties);
      return children;
    });
  }
  return false;
}
const defaultValue = schema => own(schema, 'default') ? nativeConfigValue(schema.default) : own(schema, 'const') ? nativeConfigValue(schema.const) :
  Array.isArray(schema.enum) && schema.enum.length ? nativeConfigValue(schema.enum[0]) : types(schema).includes('object') ? {} : types(schema).includes('array') ? [] : types(schema).includes('boolean') ? false : types(schema).some(type => ['integer', 'number'].includes(type)) ? (schema.minimum ?? 0) : types(schema).includes('null') ? null : '';
function containsCredential(value, path, hints, schema) {
  if (sensitive(path, hints) || schemaSensitive(path, schema) || redacted(value)) return true;
  if (Array.isArray(value)) return value.some((entry, index) => containsCredential(entry, [...path, String(index)], hints, schema));
  return object(value) && Object.entries(value).some(([key, entry]) => containsCredential(entry, [...path, key], hints, schema));
}
function displayValue(value, path, hints, schema) {
  if (sensitive(path, hints) || schemaSensitive(path, schema) || redacted(value)) return undefined;
  if (Array.isArray(value)) return value.map((entry, index) => displayValue(entry, [...path, String(index)], hints, schema) ?? null);
  if (object(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const clean = displayValue(entry, [...path, key], hints, schema); return clean === undefined ? [] : [[key, clean]];
  }));
  return value;
}

/** Includes complex container nodes rather than dropping unsupported leaves.
 * Arrays/maps/unions retain exact native JSON editors alongside simple controls. */
export function nativeConfigFields(envelope, { uiHints, effective = {}, guards = {}, guardFor, family = '', variants: selected = {} } = {}) {
  const root = envelope?.schema || envelope || {}, hints = uiHints || envelope?.uiHints || {}, fields = [], seen = new Set();
  function walk(raw, path, required = false, depth = 0) {
    const schema = resolveNativeConfigSchema(raw, root), key = id(path);
    if (seen.has(raw) || depth > 24 || fields.length >= 20000) {
      if (path.length) fields.push({ path, name: path.join('.'), kind: 'json', schema: { ...schema, __complex: true }, required, description: 'Recursive or complex native schema. Edit this exact subtree as JSON; native validation remains authoritative.', hint: hintFor(path, hints), sensitive: sensitive(path, hints) || schemaSensitive(path, root), managedReason: managed(path, guards, false, guardFor) });
      return;
    }
    const choices = variants(schema, root), hint = hintFor(path, hints), value = pathValue(effective, path);
    const branch = choices.length ? Math.max(0, Math.min(choices.length - 1, Number.isInteger(selected[key]) ? selected[key] : Math.max(0, choices.findIndex(item => matchesType(item, value))))) : -1;
    const active = branch < 0 ? schema : choices[branch], kinds = types(active), nullable = kinds.includes('null'), nonNull = kinds.filter(type => type !== 'null');
    const type = nonNull.length === 1 ? nonNull[0] : kinds.length === 1 ? kinds[0] : '';
    const kind = schema.__complex || active.__complex ? 'json' : choices.length ? 'union' : Array.isArray(active.enum) || own(active, 'const') ? 'enum' :
      type === 'object' && active.properties ? 'object' : type === 'object' ? 'map' : ['boolean', 'number', 'integer', 'string', 'array', 'null'].includes(type) ? type : 'json';
    if (path.length) fields.push({ path, name: path.join('.'), title: text(hint.label || schema.title || path.at(-1)), description: text(schema.description), schema: active,
      originalSchema: schema, variants: choices, branch, kind, type, nullable, required, hint, advanced: hint.advanced === true || hint.tags?.includes?.('advanced') === true,
      sensitive: sensitive(path, hints) || schemaSensitive(path, root), managedReason: managed(path, guards, false, guardFor), rawManagedReason: managed(path, guards, true, guardFor) });
    if (sensitive(path, hints) || schemaSensitive(path, root)) return;
    if (active.properties && !active.__complex) {
      const next = new Set(seen); next.add(raw);
      for (const [name, child] of Object.entries(active.properties)) {
        if (badKeys.has(name)) continue;
        const prior = new Set(seen); seen.clear(); for (const item of next) seen.add(item);
        walk(child, [...path, name], active.required?.includes(name) === true, depth + 1);
        seen.clear(); for (const item of prior) seen.add(item);
      }
    }
  }
  const resolved = resolveNativeConfigSchema(root, root);
  if (family && own(resolved.properties, family)) walk(resolved.properties[family], [family], resolved.required?.includes(family) === true);
  else walk(root, []);
  return fields;
}

export function parseNativeConfigField(field, input) {
  if (field.sensitive) throw invalid('Use the dedicated credential controls for this setting.');
  const schema = field.schema || {}, kind = Array.isArray(schema.enum) || own(schema, 'const') ? 'enum' : field.kind === 'union' ? (types(schema).find(type => type !== 'null') || 'null') : field.kind;
  let value;
  if (kind === 'boolean') value = input === true;
  else if (kind === 'null') value = null;
  else if (kind === 'number' || kind === 'integer') {
    if (typeof input !== 'string' || !input.trim()) throw invalid('Enter a number or reset the saved override.');
    value = Number(input);
    if (!Number.isFinite(value) || kind === 'integer' && !Number.isSafeInteger(value)) throw invalid('Enter a valid native numeric value.');
    if (typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum) throw invalid('The value is outside the native schema range.');
  } else if (kind === 'enum') {
    const values = schema.enum || [schema.const], index = Number(input);
    if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) throw invalid('Choose one native option.');
    value = values[index];
  } else if (kind === 'string') value = String(input);
  else {
    try { value = JSON.parse(input); } catch { throw invalid('Enter a complete JSON value for this native setting.'); }
    if (!matchesType(schema, value)) throw invalid('The JSON value has the wrong native schema type.');
  }
  if (redacted(value)) throw invalid('Redacted credentials cannot be written as configuration values.');
  return nativeConfigValue(value);
}

export function mountNativeConfigForm({ document: doc, mount, onChange = () => {}, onError = () => {}, onNavigate, ...initial }) {
  if (!doc?.createElement || !mount?.append) throw invalid('A configuration form mount is required.');
  let state = {}, changes = new Map(), removals = new Map(), selectedVariants = {}, destroyed = false, shown = 150, stale = false, context = '', revision, baseHash;
  const make = (tag, value = '', className = '') => { const node = doc.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
  const card = make('section', '', 'native-config-form'), toolbar = make('div', '', 'native-config-toolbar');
  const search = make('input'); search.type = 'search'; search.placeholder = 'Search every native setting'; search.autocomplete = 'off'; search.setAttribute('aria-label', 'Search native settings');
  const family = make('select'); family.setAttribute('aria-label', 'Native configuration family');
  const advancedLabel = make('label', '', 'native-check'), advanced = make('input'); advanced.type = 'checkbox'; advancedLabel.append(advanced, make('span', 'Show advanced settings'));
  const status = make('p', '', 'native-config-form-status'); status.setAttribute('role', 'status');
  const rows = make('div', '', 'native-config-form-fields'), more = make('button', 'Show more settings', 'secondary-button'); more.type = 'button';
  toolbar.append(search, family, advancedLabel); card.append(make('h3', 'Native settings form'), toolbar, status, rows, more); mount.append(card);
  function current() {
    const editable = nativeConfigValue(state.editable || {});
    for (const path of removals.values()) deletePath(editable, path);
    const result = merge(state.effective || {}, editable);
    for (const { path, value } of changes.values()) setPath(result, path, nativeConfigValue(value));
    return result;
  }
  function patch() { const result = {}; for (const { path, value } of changes.values()) setPath(result, path, nativeConfigValue(value)); return result; }
  function payload() { return { patch: patch(), removePaths: [...removals.values()].map(path => [...path]), ...(revision !== undefined ? { revision } : {}), ...(baseHash !== undefined ? { baseHash } : {}) }; }
  function notify() { if (!destroyed) { onChange(payload()); status.textContent = stale ? 'Native settings changed while this draft was open. Reload before applying.' : 'Draft changed. Validate & apply settings to save it in OpenClaw.'; } }
  function credentialCheck(value, path) {
    if (sensitive(path, state.uiHints || state.schema?.uiHints) || schemaSensitive(path, state.schema) || redacted(value)) throw invalid('Use the dedicated credential controls for this setting.');
    if (Array.isArray(value)) value.forEach((item, index) => credentialCheck(item, [...path, String(index)]));
    else if (object(value)) for (const [key, item] of Object.entries(value)) credentialCheck(item, [...path, key]);
  }
  function setValue(path, value) {
    if (destroyed || state.disabled || stale) throw invalid('Reload the connected native settings before editing.');
    safePath(path); const reason = managed(path, state.guards, object(value) || Array.isArray(value), state.guardFor); if (reason) throw invalid(reason);
    const safe = nativeConfigValue(value); credentialCheck(safe, path);
    if (Array.isArray(safe) && containsCredential(pathValue(current(), path), path, state.uiHints || state.schema?.uiHints, state.schema))
      throw invalid('Use the dedicated controls for an array containing configured credentials.');
    for (const [key, entry] of changes) if (prefix(path, entry.path)) changes.delete(key);
    for (const [key, entry] of removals) if (prefix(path, entry) || prefix(entry, path)) removals.delete(key);
    const ancestor = [...changes.values()].find(entry => prefix(entry.path, path));
    if (ancestor) setPath(ancestor.value, path.slice(ancestor.path.length), safe);
    else changes.set(id(path), { path: [...path], value: safe });
    notify();
  }
  function removeOverride(path) {
    if (destroyed || state.disabled || stale) throw invalid('Reload the connected native settings before editing.');
    safePath(path); const reason = managed(path, state.guards, true, state.guardFor); if (reason) throw invalid(reason);
    if (containsCredential(pathValue(current(), path), path, state.uiHints || state.schema?.uiHints, state.schema)) throw invalid('Use the dedicated credential controls to remove credentials.');
    for (const [key, entry] of changes) {
      if (prefix(path, entry.path)) changes.delete(key);
      else if (prefix(entry.path, path)) deletePath(entry.value, path.slice(entry.path.length));
    }
    removals.set(id(path), [...path]); notify(); draw();
  }
  function act(action) { try { action(); } catch (error) { onError(error.message); } }
  function control(field, value, changed) {
    const schema = field.schema || {}, kind = Array.isArray(schema.enum) || own(schema, 'const') ? 'enum' : field.kind === 'union' ? (types(schema).find(type => type !== 'null') || 'null') : field.kind;
    if (kind === 'null') { const input = make('select'), option = make('option', 'null'); option.value = 'null'; input.append(option); return input; }
    if (kind === 'boolean' && !field.nullable) {
      const input = make('input'); input.type = 'checkbox'; input.checked = value === true;
      input.addEventListener('change', () => act(() => changed(input.checked))); return input;
    }
    if (kind === 'enum' || field.nullable && ['boolean', 'null'].includes(kind)) {
      const input = make('select'), values = kind === 'enum' ? schema.enum || [schema.const] : [null, true, false];
      for (const [index, item] of values.entries()) { const option = make('option', typeof item === 'string' ? item : JSON.stringify(item)); option.value = String(index); input.append(option); }
      input.value = String(Math.max(0, values.findIndex(item => JSON.stringify(item) === JSON.stringify(value))));
      input.addEventListener('change', () => act(() => changed(nativeConfigValue(values[Number(input.value)])))); return input;
    }
    if (kind === 'array' && object(schema.items)) {
      const root = state.schema?.schema || state.schema || {}, itemSchema = resolveNativeConfigSchema(schema.items, root);
      const itemKind = Array.isArray(itemSchema.enum) || own(itemSchema, 'const') ? 'enum' : types(itemSchema).find(type => type !== 'null');
      if (['string', 'integer', 'number', 'boolean', 'enum'].includes(itemKind) && !containsCredential(value, field.path, state.uiHints || state.schema?.uiHints, state.schema)) {
        const list = make('div', '', 'native-config-list'), currentItems = Array.isArray(value) ? value : [];
        for (const [index, item] of currentItems.entries()) {
          const row = make('div', '', 'native-config-list-row');
          const input = control({ ...field, schema: itemSchema, kind: itemKind, nullable: types(itemSchema).includes('null') }, item, next => {
            const result = [...currentItems]; result[index] = next; changed(result); draw();
          }); input.disabled = !!state.disabled || stale; input.setAttribute('aria-label', `${field.name} item ${index + 1}`);
          const remove = make('button', 'Remove item', 'quiet-button'); remove.type = 'button'; remove.disabled = !!state.disabled || stale;
          remove.addEventListener('click', () => act(() => { changed(currentItems.filter((_entry, itemIndex) => itemIndex !== index)); draw(); }));
          row.append(input, remove); list.append(row);
        }
        const add = make('button', 'Add item', 'quiet-button'); add.type = 'button'; add.disabled = !!state.disabled || stale;
        add.addEventListener('click', () => act(() => { changed([...currentItems, defaultValue(itemSchema)]); draw(); })); list.append(add);
        const raw = make('details'), summary = make('summary', 'Native JSON array'), editor = control({ ...field, kind: 'json' }, currentItems, next => { changed(next); draw(); }); editor.disabled = !!state.disabled || stale; raw.append(summary, editor); list.append(raw);
        return list;
      }
    }
    const simple = ['string', 'integer', 'number'].includes(kind), input = make(simple && !field.hint?.multiline ? 'input' : 'textarea');
    input.type = kind === 'integer' || kind === 'number' ? 'number' : 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    if (kind === 'integer') input.step = '1'; else if (kind === 'number') input.step = 'any';
    if (typeof schema.minimum === 'number') input.min = String(schema.minimum);
    if (typeof schema.maximum === 'number') input.max = String(schema.maximum);
    input.rows = simple ? 3 : 5; input.value = value === undefined || value === null && simple ? '' : simple ? String(value) : JSON.stringify(value, null, 2);
    input.placeholder = text(field.hint?.placeholder || (own(schema, 'default') ? `Native default: ${JSON.stringify(schema.default)}` : simple ? '' : 'Native JSON value'));
    input.addEventListener('change', () => act(() => changed(parseNativeConfigField(field, input.value))));
    return input;
  }
  function draw() {
    if (destroyed) return;
    const effective = current(), all = nativeConfigFields(state.schema, { uiHints: state.uiHints, effective, guards: state.guards, guardFor: state.guardFor, family: family.value, variants: selectedVariants });
    const query = search.value.trim().toLowerCase(), filtered = all.filter(field => (!field.advanced || advanced.checked || query) &&
      (!query || `${field.name} ${field.title} ${field.description} ${JSON.stringify(field.schema)}`.toLowerCase().includes(query)));
    rows.replaceChildren();
    for (const field of filtered.slice(0, shown)) {
      const row = make('article', '', 'native-config-field'); row.dataset.nativeConfigPath = field.name;
      const label = make('label', '', 'field'), title = make('strong', `${field.title || field.name}${field.required ? ' · required' : ''}`), path = make('code', field.name);
      label.append(title, path); row.append(label);
      if (field.description) row.append(make('p', field.description, 'fine-print'));
      const disabledReason = field.managedReason || (field.sensitive ? 'Credential value is hidden. Use the dedicated credential controls.' : '');
      if (disabledReason) {
        row.append(make('p', disabledReason, 'native-config-managed'));
        if (typeof onNavigate === 'function') { const navigate = make('button', 'Open dedicated control', 'quiet-button'); navigate.type = 'button'; navigate.addEventListener('click', () => onNavigate({path: [...field.path], kind: field.sensitive ? 'credential' : 'managed', reason: disabledReason})); row.append(navigate); }
        rows.append(row); continue;
      }
      const original = pathValue(effective, field.path), hints = state.uiHints || state.schema?.uiHints;
      const display = original === undefined && own(field.schema, 'default') ? field.schema.default : original;
      const value = displayValue(display, field.path, hints, state.schema), containsSecrets = containsCredential(original, field.path, hints, state.schema), change = next => setValue(field.path, next);
      if (original === undefined) row.append(make('p', 'Not explicitly configured. The native default applies until you change this setting.', 'fine-print'));
      if (field.kind === 'union') {
        const variant = make('select'); variant.setAttribute('aria-label', `${field.name} value type`);
        for (const [index, schema] of field.variants.entries()) { const option = make('option', text(schema.title) || types(schema).join(' / ') || `Native alternative ${index + 1}`); option.value = String(index); variant.append(option); }
        variant.value = String(field.branch); variant.disabled = state.disabled || stale;
        variant.addEventListener('change', () => act(() => { selectedVariants[id(field.path)] = Number(variant.value); change(defaultValue(field.variants[Number(variant.value)])); draw(); })); label.append(variant);
      }
      if (field.kind === 'object' || field.kind === 'union' && types(field.schema).includes('object')) {
        const details = make('details'), summary = make('summary', 'Advanced native JSON for this subtree'); details.append(summary);
        const editor = control({ ...field, kind: 'json' }, value, change); editor.disabled = state.disabled || stale || !!field.rawManagedReason; details.append(editor);
        if (field.rawManagedReason) details.append(make('p', 'Edit individual compatible fields below; this subtree contains managed paths.', 'fine-print'));
        row.append(details);
      } else {
        const input = control(field, value, change); input.disabled = state.disabled || stale;
        if (Array.isArray(original) && containsSecrets) { input.disabled = true; row.append(make('p', 'This array contains configured credentials. Use its dedicated controls so editing it cannot erase hidden credentials.', 'native-config-managed')); }
        input.setAttribute('aria-label', field.name); label.append(input);
        if (['array', 'map', 'json'].includes(field.kind)) row.append(make('p', 'This exact native subtree accepts JSON, including all array items and map keys. OpenClaw validates its full schema when you apply.', 'fine-print'));
      }
      if (containsSecrets) row.append(make('p', 'Credential fields are excluded from this editor and use dedicated controls.', 'fine-print'));
      if (field.nullable && !field.variants?.length && !['boolean', 'enum'].includes(field.kind)) {
        const mode = make('select'); mode.setAttribute('aria-label', `${field.name} null value`);
        for (const [key, name] of [['value', 'Use a value'], ['null', 'Use native null']]) { const option = make('option', name); option.value = key; mode.append(option); }
        mode.value = original === null ? 'null' : 'value'; mode.disabled = state.disabled || stale;
        mode.addEventListener('change', () => act(() => { change(mode.value === 'null' ? null : defaultValue({...field.schema, type: field.type})); draw(); })); row.append(mode);
      }
      const reset = make('button', 'Reset saved override', 'quiet-button'); reset.type = 'button'; reset.disabled = state.disabled || stale || pathValue(state.editable, field.path) === undefined;
      reset.addEventListener('click', () => act(() => removeOverride(field.path))); row.append(reset);
      if (removals.has(id(field.path))) row.append(make('p', 'Pending reset to the native baseline. Apply settings to read the resulting value.', 'fine-print'));
      rows.append(row);
    }
    more.hidden = filtered.length <= shown; more.disabled = state.disabled || stale;
    if (!changes.size && !removals.size) status.textContent = `${filtered.length} native setting${filtered.length === 1 ? '' : 's'}${filtered.length > shown ? ` · showing ${shown}; use search or Show more settings` : ''}. Changes are validated by the local OpenClaw runtime.`;
    else if (stale) status.textContent = 'Native settings changed while this draft was open. Reload before applying.';
  }
  function render(next = {}) {
    if (destroyed) return;
    const nextContext = String(next.contextKey ?? context);
    if (nextContext !== context) reset();
    if ((changes.size || removals.size) && next.revision !== undefined && revision !== undefined && next.revision !== revision) stale = true;
    if ((changes.size || removals.size) && next.baseHash !== undefined && baseHash !== undefined && next.baseHash !== baseHash) stale = true;
    state = { ...state, ...next }; context = nextContext;
    if (!changes.size && !removals.size) { revision = state.revision; baseHash = state.baseHash; stale = false; }
    if (next.family !== undefined) family.value = next.family;
    const selectedFamily = family.value || '', root = state.schema?.schema || state.schema || {};
    family.replaceChildren();
    for (const name of ['', ...Object.keys(resolveNativeConfigSchema(root, root).properties || {}).filter(key => !badKeys.has(key))]) { const option = make('option', name || 'All native families'); option.value = name; family.append(option); }
    family.value = selectedFamily; search.disabled = family.disabled = advanced.disabled = !!state.disabled;
    if (next.query !== undefined) search.value = next.query;
    if (next.showAdvanced !== undefined) advanced.checked = next.showAdvanced === true;
    draw();
  }
  function reset() { changes = new Map(); removals = new Map(); selectedVariants = {}; stale = false; revision = undefined; baseHash = undefined; shown = 150; }
  search.addEventListener('input', () => { shown = 150; draw(); });
  family.addEventListener('change', () => { shown = 150; draw(); }); advanced.addEventListener('change', draw);
  more.addEventListener('click', () => { shown += 150; draw(); });
  render(initial);
  return { render, update: render, getPatch: () => patch(), getRemovedPaths: () => payload().removePaths, getPayload: payload,
    setValue, removeOverride, reset(next = {}) { reset(); render(next); }, destroy() { destroyed = true; reset(); card.remove?.(); if (!card.remove) mount.replaceChildren(); } };
}
