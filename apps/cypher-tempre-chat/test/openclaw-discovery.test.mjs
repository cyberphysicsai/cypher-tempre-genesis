import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverTimechains } from "../openclaw/discovery.mjs";

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"ct-discovery-"));
  t.after(async()=>{ const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(resolved).startsWith("ct-discovery-"));await fs.rm(resolved,{recursive:true,force:true}); });
  return root;
}
async function chain(root) {
  await fs.mkdir(path.join(root,"chain"),{recursive:true});await fs.mkdir(path.join(root,"registry"),{recursive:true});
  // Invalid UTF-8 proves discovery does not parse chain/registry content.
  await Promise.all(["chain/rings.jsonl","registry/modalities.json","registry/senses.json"].map(file=>fs.writeFile(path.join(root,file),Buffer.from([255,0,254]))));
}
test("known roots expose only candidate paths and never parse private chain contents",async t=>{
  const home=await fixture(t), agent=path.join(home,".openclaw","workspace","skills","my-agent");await chain(agent);
  await chain(path.join(home,"unrelated","secret-agent"));
  const result=await discoverTimechains({home});
  assert.deepEqual(result.candidates,[{root:agent,label:"my-agent",source:"OpenClaw workspace",verified:false}]);
  assert.equal(result.complete,true);assert.equal(JSON.stringify(result).includes("secret-agent"),false);
});
test("incomplete folders are not identified and existing ChainChat agents are eligible",async t=>{
  const home=await fixture(t), data=path.join(home,"app-data"), agent=path.join(data,"agents","existing");await chain(agent);
  await fs.mkdir(path.join(home,".hermes","skills","partial","chain"),{recursive:true});await fs.writeFile(path.join(home,".hermes","skills","partial","chain","rings.jsonl"),"not enough");
  const result=await discoverTimechains({home,agentDataRoot:data});assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].root,agent);
});
test("scan budgets bound traversal and report incomplete coverage",async t=>{
  const home=await fixture(t), base=path.join(home,".codex","skills");
  for(let i=0;i<8;i++) await chain(path.join(base,"agent"+i));
  const result=await discoverTimechains({home,maxDirectories:3});assert.ok(result.visitedDirectories<=3);assert.equal(result.complete,false);
  const shallow=await discoverTimechains({home,maxDepth:1,maxCandidates:2});assert.equal(shallow.candidates.length,2);assert.equal(shallow.complete,false);
});
test("symbolic links cannot expand the user's selected discovery scope",async t=>{
  const home=await fixture(t), outside=path.join(home,"outside"), base=path.join(home,".agents","skills");await chain(outside);await fs.mkdir(base,{recursive:true});
  try {await fs.symlink(outside,path.join(base,"linked"),process.platform==="win32"?"junction":"dir");}
  catch(error) { if(["EPERM","EACCES"].includes(error.code)){t.skip("Link creation unavailable on this host.");return;}throw error; }
  assert.equal((await discoverTimechains({home})).candidates.length,0);
});
