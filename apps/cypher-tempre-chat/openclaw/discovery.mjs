/** Explicit, bounded metadata-only discovery. Call only after a local user action.
 * Never imports Python or reads ring/registry contents; pairing verifies a chosen root.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "cache", ".cache", "downloads", "blockspace"]);
const identity = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (root, value) => identity(value) === identity(root) || identity(value).startsWith(identity(root) + path.sep);

async function kind(file, type) {
  try { const stat = await fs.lstat(file); return !stat.isSymbolicLink() && (type === "directory" ? stat.isDirectory() : stat.isFile()); }
  catch (error) { if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return false; throw error; }
}
async function chainRoot(root) {
  if (!await kind(path.join(root,"chain"),"directory") || !await kind(path.join(root,"registry"),"directory")) return false;
  return (await Promise.all(["chain/rings.jsonl", "registry/modalities.json", "registry/senses.json"].map(file=>kind(path.join(root,file),"file")))).every(Boolean);
}
function limit(value, fallback, maximum) {
  return value === undefined ? fallback : Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : (()=>{ throw new Error("Invalid discovery limit."); })();
}

export async function discoverTimechains({ agentDataRoot, home = os.homedir(), maxDepth, maxDirectories, maxCandidates } = {}) {
  maxDepth = limit(maxDepth, 5, 12); maxDirectories = limit(maxDirectories, 1500, 5000); maxCandidates = limit(maxCandidates, 100, 500);
  const locations = [
    ["OpenClaw workspace",path.join(home,".openclaw","workspace")],
    ["OpenClaw skills",path.join(home,".openclaw","skills")],
    ["Hermes skills",path.join(home,".hermes","skills")],
    ["Codex skills",path.join(home,".codex","skills")],
    ["Agent skills",path.join(home,".agents","skills")],
    ...(agentDataRoot ? [["ChainChat agents",path.join(path.resolve(agentDataRoot),"agents")]] : []),
  ];
  const candidates = [], seen = new Set(), roots = [], queue = [];
  for (const [source,root] of locations) {
    if (!await kind(root,"directory")) { roots.push({source,available:false}); continue; }
    const real = await fs.realpath(root);
    // A known directory that resolves through a link outside its named scope is not a scan grant.
    if (identity(real) !== identity(root)) { roots.push({source,available:false,linked:true}); continue; }
    roots.push({source,available:true}); queue.push({root:real,anchor:real,source,depth:0});
  }
  let visited = 0, truncated = false, depthLimited = false;
  while (queue.length && visited < maxDirectories && candidates.length < maxCandidates) {
    const current = queue.shift(), key = identity(current.root);
    if (seen.has(key)) continue;
    seen.add(key); visited++;
    if (!await kind(current.root,"directory")) continue;
    const real = await fs.realpath(current.root);
    if (identity(real) !== key || !inside(current.anchor,real)) continue;
    if (await chainRoot(real)) {
      candidates.push({root:real,label:path.basename(real),source:current.source,verified:false});
      continue; // Never enumerate an identified agent's history/blockspace/learner data.
    }
    let children;
    try { children = await fs.readdir(real,{withFileTypes:true}); }
    catch(error) { if(["EACCES","EPERM","ENOENT"].includes(error.code)) continue; throw error; }
    const directories = children.filter(entry=>entry.isDirectory() && !entry.isSymbolicLink() && !SKIP.has(entry.name)).sort((a,b)=>a.name.localeCompare(b.name));
    if (current.depth >= maxDepth) { if(directories.length) depthLimited=true; continue; }
    for (const entry of directories) {
      if (queue.length + visited >= maxDirectories) { truncated=true; break; }
      queue.push({...current,root:path.join(real,entry.name),depth:current.depth+1});
    }
  }
  truncated ||= queue.length > 0 || depthLimited;
  return {candidates,roots,visitedDirectories:visited,complete:!truncated,
    limits:{maxDepth,maxDirectories,maxCandidates},
    notice:"Candidates are detected from directory structure only. Select one for native chain and registry verification; no chain is paired automatically."};
}
