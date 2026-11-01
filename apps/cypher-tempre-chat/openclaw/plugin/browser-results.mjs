/** Reduce native browser receipts before they enter model context or evidence. */
const OWNED_PROFILE = 'chainchat-owned';
const PRIVATE_KEYS = new Set(['cdp', 'cdpurl', 'cdpport', 'wsurl', 'websocketurl', 'websocketdebuggerurl', 'devtoolsfrontendurl',
  'debuggerurl', 'debuggeraddress', 'browserwsendpoint', 'browserendpoint', 'browserurl', 'controlurl', 'controlport',
  'userdatadir', 'profiledir', 'profiledirectory', 'profilepath', 'executablepath', 'detectedexecutablepath', 'binarypath',
  'mcpcommand', 'pid', 'processid', 'systemprofiles', 'systemprofilesunavailable', 'importableprofiles', 'relayport', 'wsendpoint']);
const privateKey = key => PRIVATE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => new Error('The owned browser result could not be safely reduced.');
const PRIVATE_VALUE = '[private browser control]';
const PRIVATE_URL = /(?:https?|wss?):\/\/(?:[^\s/@"'<>]+@)?(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?=[:/?#\s"'<>]|$)(?::\d+)?(?:[/?#][^\s"'<>\\]*)?/gi;

/** Upstream wraps some JSON in external-content labels. Parse only complete JSON
 * objects/arrays while retaining the wrapper exactly; never evaluate source. */
function jsonSegments(text) {
  const found = [];
  for (let cursor = 0, attempts = 0; cursor < text.length && attempts < 32; cursor++) {
    if (!['{', '['].includes(text[cursor])) continue;
    attempts++; const start = cursor, stack = [text[cursor]]; let quoted = false, escaped = false;
    for (let end = cursor + 1; end < text.length; end++) {
      const character = text[end];
      if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; continue; }
      if (character === '"') { quoted = true; continue; }
      if (character === '{' || character === '[') stack.push(character);
      else if (character === '}' || character === ']') {
        if (stack.pop() !== (character === '}' ? '{' : '[')) break;
        if (!stack.length) {
          try { found.push({ start, end: end + 1, value: JSON.parse(text.slice(start, end + 1)) }); cursor = end; } catch {}
          break;
        }
      }
    }
  }
  return found;
}

/** `description` is a real private authority.describe() snapshot, never model
 * input. This projection avoids running upstream's personal-profile discovery. */
export function ownedBrowserProfilesResult(description) {
  if (!plain(description) || description.profile !== OWNED_PROFILE || description.isolated !== true ||
      typeof description.running !== 'boolean' || typeof description.closed !== 'boolean') throw fail();
  const payload = { scope: 'owned-profile-only', profiles: [{ name: description.profile, isolated: description.isolated,
    running: description.running, closed: description.closed }] };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload };
}

/** Every returned copy is reduced, including embedded native JSON text.
 * privateValues lets the host additionally remove known private path/URL echoes;
 * these values are never added to the returned result. Image bytes are preserved. */
export function sanitizeOwnedBrowserResult(result, { privateValues = [] } = {}) {
  if (!plain(result) || !Array.isArray(privateValues)) throw fail();
  const secrets = new Set(privateValues.filter(value => typeof value === 'string' && value.length >= 4));
  let visited = 0;
  const inspect = (value, depth = 0, ancestors = new Set()) => {
    if (depth > 48 || ++visited > 20000) throw fail();
    if (typeof value === 'string') {
      if (!value.startsWith('data:image/')) for (const segment of jsonSegments(value)) inspect(segment.value, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (ancestors.has(value)) throw fail(); const next = new Set(ancestors); next.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (privateKey(key) && typeof entry === 'string' && entry.length >= 4) secrets.add(entry);
      inspect(entry, depth + 1, next);
    }
  };
  inspect(result);
  const variants = [...new Set([...secrets].flatMap(value => [value, JSON.stringify(value).slice(1, -1), value.replaceAll('\\', '/')]))].sort((a, b) => b.length - a.length);
  const scrub = text => {
    let value = text;
    for (const secret of variants) value = value.split(secret).join(PRIVATE_VALUE);
    return value.replace(PRIVATE_URL, PRIVATE_VALUE).replace(/devtools:\/\/[^\s"'<>]*/gi, PRIVATE_VALUE);
  };
  visited = 0;
  const reduce = (value, depth = 0) => {
    if (depth > 48 || ++visited > 20000) throw fail();
    if (typeof value === 'string') {
      if (value.startsWith('data:image/')) return value;
      const segments = jsonSegments(value); let cursor = 0, output = '';
      for (const segment of segments) { output += value.slice(cursor, segment.start) + JSON.stringify(reduce(segment.value, depth + 1), null, 2); cursor = segment.end; }
      return scrub(segments.length ? output + value.slice(cursor) : value);
    }
    if (Array.isArray(value)) return value.map(entry => reduce(entry, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const reduced = {};
    for (const [key, entry] of Object.entries(value)) {
      if (privateKey(key)) continue;
      let selected;
      if (key.toLowerCase() === 'profiles' && Array.isArray(entry)) {
        selected = entry.filter(profile => plain(profile) && (profile.name || profile.profile) === OWNED_PROFILE).map(profile => reduce(profile, depth + 1));
      } else if (key.toLowerCase() === 'profiles' && plain(entry)) {
        selected = Object.hasOwn(entry, OWNED_PROFILE) ? { [OWNED_PROFILE]: reduce(entry[OWNED_PROFILE], depth + 1) } : {};
      } else selected = value.type === 'image' && key === 'data' ? entry : reduce(entry, depth + 1);
      Object.defineProperty(reduced, key, { value: selected, enumerable: true, writable: true, configurable: true });
    }
    return reduced;
  };
  return reduce(result);
}
