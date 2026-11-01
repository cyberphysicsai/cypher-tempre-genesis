import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import path from 'node:path';

const denied = message => Object.assign(new Error(message), { code: 'PLUGIN_SOURCE_RESOLUTION_FAILED', status: 422 });
async function bytes(response, limit) {
  if (!response.ok) throw denied('The package registry did not return the requested artifact.');
  let size = 0; const parts = [];
  for await (const part of response.body) { size += part.length; if (size > limit) throw denied('The package exceeds the read-only resolution limit.'); parts.push(part); }
  return Buffer.concat(parts);
}
function manifestFiles(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 }), selected = new Map();
  let cursor = 0, pendingPath = null, pendingSize = null, count = 0;
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512); cursor += 512;
    if (header.every(byte => byte === 0)) break;
    if (++count > 50000) throw denied('The package archive contains too many entries.');
    const string = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    let name = (string(345, 500) ? string(345, 500) + '/' : '') + string(0, 100);
    const size = pendingSize ?? parseInt(string(124, 136).trim() || '0', 8), type = string(156, 157) || '0'; pendingSize = null;
    if (!Number.isSafeInteger(size) || size < 0 || size > 128 * 1024 * 1024 || cursor + size > tar.length) throw denied('Invalid package archive entry.');
    const content = tar.subarray(cursor, cursor + size); cursor += Math.ceil(size / 512) * 512;
    if (type === 'L') { pendingPath = content.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x' || type === 'g') {
      let index = 0;
      while (index < content.length) {
        const space = content.indexOf(32, index), length = Number(content.subarray(index, space).toString());
        if (space < 0 || !Number.isInteger(length) || length < 3 || index + length > content.length) throw denied('Invalid archive metadata.');
        const record = content.subarray(space + 1, index + length - 1).toString('utf8'), equals = record.indexOf('='), key = record.slice(0, equals), value = record.slice(equals + 1);
        if (['path', 'size', 'linkpath'].includes(key) && type === 'g') throw denied('Ambiguous global archive metadata is denied.');
        if (key === 'path') pendingPath = value; if (key === 'size') pendingSize = Number(value);
        if (key === 'linkpath') throw denied('Linked package entries need native source review.');
        index += length;
      }
      continue;
    }
    name = pendingPath ?? name; pendingPath = null;
    const pathParts = name.replace(/\/$/, '').split('/');
    if (name.startsWith('/') || name.includes('\\') || pathParts.some(part => !part || part === '.' || part === '..') || /^[a-z]:/i.test(name) || ['1', '2'].includes(type)) throw denied('Unsafe or linked package archive paths are denied.');
    if (['package/package.json', 'package/openclaw.plugin.json'].includes(name.toLowerCase()) && name !== name.toLowerCase()) throw denied('Ambiguous package identity filename casing is denied.');
    if (['package/package.json', 'package/openclaw.plugin.json'].includes(name)) {
      if (type !== '0' || content.length > 1024 * 1024 || selected.has(name)) throw denied('Ambiguous package identity files are denied.');
      selected.set(name, JSON.parse(content.toString('utf8')));
    }
  }
  const pkg = selected.get('package/package.json'), manifest = selected.get('package/openclaw.plugin.json');
  if (!pkg || !manifest || typeof manifest.id !== 'string' || !manifest.id.trim()) throw denied('The archive has no single native OpenClaw plugin manifest.');
  return { pkg, manifest };
}

/** Resolves public registry npm specs without extraction, lifecycle scripts or
 * plugin imports. Private/custom registries can supply their native resolver.
 */
export function createNpmPluginSourceResolver({ packageRoot, fetchImpl = fetch, maxArchiveBytes = 64 * 1024 * 1024 } = {}) {
  let semver;
  if (packageRoot) semver = createRequire(path.join(packageRoot, 'package.json'))('semver');
  return async source => {
    if (source?.source !== 'npm') return null;
    const match = /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:@(.+))?$/i.exec(source.spec || '');
    if (!match) return null;
    const [, name, selector = 'latest'] = match;
    const metadata = JSON.parse((await bytes(await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { redirect: 'error', signal: AbortSignal.timeout(30000) }), 32 * 1024 * 1024)).toString('utf8'));
    const version = metadata['dist-tags']?.[selector] || (metadata.versions?.[selector] ? selector : semver?.maxSatisfying(Object.keys(metadata.versions || {}), selector));
    const release = metadata.versions?.[version], integrity = release?.dist?.integrity;
    if (!release || typeof integrity !== 'string') throw denied('The selected npm release has no verifiable artifact integrity.');
    const url = new URL(release.dist.tarball);
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.port) throw denied('This registry artifact requires an explicit native source resolver.');
    const archive = await bytes(await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(30000) }), maxArchiveBytes);
    const strongest = integrity.split(/\s+/).map(value => /^(sha512|sha384|sha256)-([A-Za-z0-9+/=]+)(?:\?.*)?$/.exec(value)).filter(Boolean)
      .sort((a, b) => Number(b[1].slice(3)) - Number(a[1].slice(3)))[0];
    if (!strongest) throw denied('Unsupported npm artifact integrity.');
    const expected = Buffer.from(strongest[2], 'base64'), actual = createHash(strongest[1]).update(archive).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw denied('The npm archive did not match its registry integrity.');
    const { pkg, manifest } = manifestFiles(archive);
    if (pkg.name !== name || pkg.version !== version) throw denied('The npm package identity changed during resolution.');
    if (source.expectedPluginId && source.expectedPluginId !== manifest.id || source.expectedIntegrity && source.expectedIntegrity !== integrity) throw denied('The resolved package does not match the requested identity pin.');
    return { resolved: true, pluginId: manifest.id.trim(), packageName: name, version, integrity,
      source: { source: 'npm', spec: `${name}@${version}`, pin: true, expectedPluginId: manifest.id.trim(), expectedIntegrity: integrity } };
  };
}
