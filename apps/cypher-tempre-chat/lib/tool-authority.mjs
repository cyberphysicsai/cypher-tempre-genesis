import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createHash } from 'node:crypto';

// This catalogue is deliberately concrete. A new upstream tool is not a grant.
export const SUPPORTED_HOST_TOOLS = Object.freeze(['read', 'write', 'edit', 'web_fetch', 'browser', 'exec', 'process']);
const KNOWN = new Set(SUPPORTED_HOST_TOOLS);
const EXECUTION = new Set(['exec', 'process']);
const KEYS = ['enabled', 'tools', 'roots', 'networkHosts', 'allowExecution', 'acknowledged'];
const denied = message => Object.assign(new Error(message), { code: 'HOST_TOOL_DENIED', status: 403 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const inside = (root, target) => { const relative = path.relative(root, target); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const strings = (value, limit, length) => Array.isArray(value) && value.length <= limit && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= length && !item.includes('\0'));
const unique = values => [...new Set(values)];
const localAbsolutePath = value => typeof value === 'string' && path.isAbsolute(value) &&
  !value.startsWith('\\\\') && !value.startsWith('//');

function hostname(value) {
  if (typeof value !== 'string' || value.length > 253 || /[\s\/:@?#*\\]/.test(value)) throw denied('Network grants require exact public hostnames.');
  const parsed = new URL(`https://${value}`);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || net.isIP(host))
    throw denied('Private names and IP addresses cannot be network grants.');
  if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !host.includes('.')) throw denied('Invalid public hostname.');
  return host;
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const lower = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    const [first, second = '0'] = lower.split(':');
    // Only ordinary global-unicast IPv6; deny mapped, transition, ULA and link-local.
    return /^[23][0-9a-f]{0,3}:/.test(lower) && first !== '2002' &&
      !(first === '2001' && (parseInt(second || '0', 16) < 0x200 || second === 'db8')) &&
      !(parseInt(first, 16) >= 0x3ff0);
  }
  return false;
}

async function canonicalDirectory(directory) {
  if (!localAbsolutePath(directory) || directory.length > 32768 || directory.includes('\0')) throw denied('Tool roots must be local absolute directories; UNC and device paths are denied.');
  const real = await fs.realpath(directory).catch(() => { throw denied('A granted tool directory is unavailable.'); });
  if (!localAbsolutePath(real)) throw denied('A tool root cannot resolve to a network or device path.');
  if (!(await fs.stat(real)).isDirectory()) throw denied('Tool roots must be directories.');
  // A volume root makes all local documents implicitly accessible.
  if (path.parse(real).root === real) throw denied('A filesystem volume cannot be a tool root.');
  return real;
}

async function protectedPaths(roots) {
  return Promise.all(roots.filter(Boolean).map(async root => {
    if (!path.isAbsolute(root)) throw denied('Protected roots must be absolute.');
    return fs.realpath(root).catch(() => path.resolve(root));
  }));
}

/** Validate a human-owned grant before persisting or registering a run. */
export async function validateToolAuthority(grant = {}, { protectedRoots = [] } = {}) {
  if (!plain(grant) || Object.keys(grant).some(key => !KEYS.includes(key))) throw denied('Invalid host-tool authority.');
  for (const key of ['enabled', 'allowExecution', 'acknowledged']) if (grant[key] !== undefined && typeof grant[key] !== 'boolean') throw denied('Invalid host-tool authority flag.');
  if (!strings(grant.tools ?? [], 7, 64) || !strings(grant.roots ?? [], 32, 32768) || !strings(grant.networkHosts ?? [], 32, 253)) throw denied('Host-tool authority exceeds its bounds.');
  const tools = unique(grant.tools ?? []);
  if (tools.some(name => !KNOWN.has(name))) throw denied('An unknown tool cannot be granted.');
  const enabled = grant.enabled === true, allowExecution = grant.allowExecution === true, acknowledged = grant.acknowledged === true;
  if (enabled && !acknowledged) throw denied('Explicit local acknowledgement is required to enable host tools.');
  if (enabled && tools.includes('browser')) throw denied('Browser grants require a managed network adapter; requested-host checks alone cannot safely contain Chromium network access.');
  if (enabled && tools.some(name => EXECUTION.has(name)) && !allowExecution) throw denied('Execution tools require a separate operating-system execution grant.');
  const roots = unique(await Promise.all((grant.roots ?? []).map(canonicalDirectory)));
  const protectedReal = await protectedPaths(protectedRoots);
  if (roots.some(root => protectedReal.some(protectedRoot => inside(protectedRoot, root)))) throw denied('Application and Timechain files cannot be tool roots.');
  return { enabled, tools, roots, networkHosts: unique((grant.networkHosts ?? []).map(hostname)), allowExecution, acknowledged };
}

export function toolAuthorityFingerprint(grant) {
  return createHash('sha256').update(JSON.stringify(grant)).digest('hex');
}

function checkedParams(params, allowed) {
  if (!plain(params) || Object.keys(params).some(key => ['__proto__', 'prototype', 'constructor'].includes(key) || !allowed.includes(key))) throw denied('Unsupported tool parameters.');
  let size;
  try { size = Buffer.byteLength(JSON.stringify(params)); } catch { throw denied('Invalid tool parameters.'); }
  if (size > 512 * 1024) throw denied('Tool parameters exceed the review limit.');
  return structuredClone(params);
}

async function canonicalFile(file, mayCreate) {
  if (!localAbsolutePath(file) || !file || file.length > 32768 || file.includes('\0')) throw denied('File tools require a local absolute path.');
  const resolved = path.resolve(file);
  try { return await fs.realpath(resolved); }
  catch (error) {
    if (!mayCreate || error.code !== 'ENOENT') throw denied('The requested file is unavailable.');
    // Resolve the nearest existing ancestor, so symlinks cannot escape a root.
    let parent = path.dirname(resolved), suffix = [path.basename(resolved)];
    while (parent !== path.dirname(parent)) {
      try { return path.join(await fs.realpath(parent), ...suffix); }
      catch (parentError) { if (parentError.code !== 'ENOENT') throw denied('The requested path cannot be resolved.'); }
      suffix.unshift(path.basename(parent)); parent = path.dirname(parent);
    }
    throw denied('The requested path cannot be resolved.');
  }
}

async function publicUrl(value, hosts, lookup) {
  let url;
  try { url = new URL(value); } catch { throw denied('A valid public HTTPS URL is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw denied('Only public HTTPS destinations on the standard port are permitted.');
  const host = hostname(url.hostname);
  if (!hosts.includes(host)) throw denied('This network destination has no local grant.');
  const records = await lookup(host, { all: true, verbatim: true }).catch(() => { throw denied('The network destination could not be verified.'); });
  if (!Array.isArray(records) || !records.length || records.some(record => !isPublicAddress(record.address))) throw denied('Private and reserved network destinations are denied.');
  url.hostname = host;
  return url.href;
}

/** Checks one concrete native call. It never executes a tool or writes a chain.
 * Network checks constrain the requested destination. Upstream DNS/redirect SSRF
 * protection must remain enabled as well. Exec is broad OS power, not a sandbox.
 */
export async function authorizeToolCall(grant, tool, { protectedRoots = [], lookup = dns.lookup } = {}) {
  const authority = await validateToolAuthority(grant, { protectedRoots });
  if (JSON.stringify(authority.roots) !== JSON.stringify(grant?.roots ?? [])) throw denied('A granted directory changed its canonical location.');
  if (!authority.enabled || !authority.acknowledged || !plain(tool) || typeof tool.name !== 'string' ||
      !authority.tools.includes(tool.name) || typeof tool.callId !== 'string' || !tool.callId || tool.callId.length > 256) throw denied('No current local grant permits this tool call.');
  const name = tool.name;
  let params;
  if (['read', 'write', 'edit'].includes(name)) {
    const allowed = name === 'read' ? ['path', 'file_path', 'offset', 'limit'] : name === 'write' ? ['path', 'file_path', 'content'] : ['path', 'file_path', 'oldText', 'newText', 'old_string', 'new_string', 'replace_all'];
    params = checkedParams(tool.params, allowed);
    if (params.path !== undefined && params.file_path !== undefined && params.path !== params.file_path) throw denied('Ambiguous file paths are denied.');
    const file = await canonicalFile(params.path ?? params.file_path, name === 'write');
    const stat = await fs.stat(file).catch(error => { if (name === 'write' && error.code === 'ENOENT') return null; throw denied('The requested file is unavailable.'); });
    if (stat && (!stat.isFile() || stat.nlink > 1)) throw denied('File tools cannot access directories or multiply linked files.');
    const blocked = await protectedPaths(protectedRoots);
    if (!authority.roots.some(root => inside(root, file)) || blocked.some(root => inside(root, file) || name === 'read' && inside(file, root))) throw denied('The requested file is outside this tool grant.');
    if (name === 'write' && typeof params.content !== 'string') throw denied('File writes require explicit content.');
    if (name === 'edit' && (typeof (params.oldText ?? params.old_string) !== 'string' || typeof (params.newText ?? params.new_string) !== 'string')) throw denied('File edits require exact old and new text.');
    if ('path' in params) params.path = file; else params.file_path = file;
  } else if (name === 'web_fetch') {
    params = checkedParams(tool.params, ['url', 'extractMode', 'maxChars']);
    params.url = await publicUrl(params.url, authority.networkHosts, lookup);
  } else if (name === 'browser') {
    params = checkedParams(tool.params, ['action', 'targetUrl', 'url', 'profile', 'target', 'targetId']);
    if (!['open', 'navigate'].includes(params.action) || params.profile && params.profile !== 'openclaw' || params.target && params.target !== 'host' || params.url && params.targetUrl && params.url !== params.targetUrl) throw denied('Only an isolated browser navigation with an explicit destination is supported.');
    const url = await publicUrl(params.targetUrl ?? params.url, authority.networkHosts, lookup);
    if ('url' in params) params.url = url; else params.targetUrl = url;
    params.profile = 'openclaw'; params.target = 'host';
  } else if (EXECUTION.has(name)) {
    if (!authority.allowExecution || !authority.acknowledged) throw denied('Operating-system execution was not explicitly granted.');
    params = checkedParams(tool.params, name === 'exec' ? ['command', 'workdir', 'yieldMs', 'background', 'timeout', 'pty', 'elevated', 'host', 'security', 'ask', 'node'] : ['action', 'sessionId', 'data', 'keys', 'hex', 'literal', 'offset', 'limit', 'timeout', 'text', 'bracketed']);
    if (name === 'exec' && (typeof params.command !== 'string' || !params.command.trim() || params.command.length > 65536)) throw denied('Execution requires an explicit bounded command.');
    if (name === 'exec' && (params.elevated === true || params.host && params.host !== 'gateway' || params.node)) throw denied('This grant does not authorize elevation or another machine.');
    if (name === 'process' && !['list', 'poll', 'log', 'write', 'send-keys', 'paste', 'submit', 'kill'].includes(params.action)) throw denied('Unsupported process action.');
  } else throw denied('Unsupported host tool.');
  return { name, params, callId: tool.callId };
}
