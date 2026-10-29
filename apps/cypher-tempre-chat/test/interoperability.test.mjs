/** Independent original-engine roundtrips; all model transports are local fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { engine } from '../lib/engine.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';

const PRODUCT=path.resolve(import.meta.dirname,'..');
const ORIGINAL=path.resolve(process.env.CT_ORIGINAL_SKILL || path.join(PRODUCT,'../../work/source-v3.30.08/skills/codex/cypher-tempre-self-model'));
const HAS_ORIGINAL=await fs.access(path.join(ORIGINAL,'cambium.py')).then(()=>true,()=>false);
const referenceTest=HAS_ORIGINAL?test:test.skip;
const scores=Object.fromEntries(DIMENSIONS.map(key=>[key,240]));
const fruitages=Object.fromEntries(FRUITS.map(key=>[key,240]));
const assessment={approved:true,fruitages,rationale:'Explicit, bounded and reversible synthetic test operation.'};
const goodReview=()=>({approved:true,decision:'approve',usedRings:[],scores,fruits:fruitages,rationale:assessment.rationale});
const ANSWER='The notebook records specimen Opal Lantern 318 with calibration uncertainty of 0.25 units. Further inference remains uncertain.';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function python(args,input){
  const child=spawn(process.env.CT_CHAT_PYTHON || (process.platform==='win32'?'python':'python3'),args,
    {cwd:PRODUCT,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.stdin.end(input===undefined?'':JSON.stringify(input));
  const [exitCode]=await once(child,'close');
  return {exitCode,stdout,stderr};
}
async function original(root,mode,extra={}){
  const out=await python([path.join(PRODUCT,'test/helpers/original-interop.py'),ORIGINAL],{root,mode,...extra});
  assert.equal(out.exitCode,0,out.stderr||out.stdout);return JSON.parse(out.stdout);
}
async function companion(root,enginePath,command,args=[]){
  const result=await python([path.join(PRODUCT,'skill_interop.py'),command,'--root',root,'--engine',enginePath,...args]);
  assert.equal(result.exitCode,0,result.stderr||result.stdout);return JSON.parse(result.stdout);
}
async function importComplete(root,enginePath,packFile,directory,label){
  const preview=await companion(root,enginePath,'preview',['--pack',packFile]);
  const reviewFile=path.join(directory,label+'-review.json');
  await fs.writeFile(reviewFile,JSON.stringify({planHash:preview.planHash,expectedHead:preview.expectedHead,
    reviewedAt:new Date().toISOString(),scores,assessment}));
  return companion(root,enginePath,'import',['--pack',packFile,'--review',reviewFile,
    '--expected-head',preview.expectedHead,'--plan-hash',preview.planHash,'--confirm']);
}
function definitions(snapshot){
  return Object.fromEntries(['modalities','senses'].flatMap(plural=>snapshot.grown[plural]).map(fac=>[fac.name,fac]));
}
function assertFacultyMechanisms(source,target){
  const actual=definitions(target);
  for(const [name,faculty] of Object.entries(definitions(source))){
    assert.ok(actual[name],name+' present');
    for(const field of ['function','category','seed_terms','orientation','effect','status','dormancy_reason'])
      assert.deepEqual(actual[name][field],faculty[field],name+'.'+field);
    assert.deepEqual(target.ops.ops[name],source.ops.ops[name],name+' primitive spec');
  }
}
async function fixture(t,{generate,review}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ct-interoperability-'));
  const root=path.join(directory,'original');
  const initial=await original(root,'initialize');
  const generated=[],reviewed=[],native=[];
  const app=await createApp({dataDir:path.join(directory,'bridge'),pairingCode:'INTEROPERABILITY',
    licenseConfig:{mode:'holdings',required:false},
    engine:async request=>{native.push(structuredClone(request));return engine(request);},
    generate:async(config,args)=>{generated.push({config,args});return generate?generate(config,args):{text:ANSWER};},
    review:async(config,args)=>{reviewed.push({config,args});return review?review(config,args):goodReview();}});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const base=`http://127.0.0.1:${app.server.address().port}`;let token;
  async function call(endpoint,body){
    const res=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:{...(token?{authorization:`Bearer ${token}`} :{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:res.status,body:await res.json()};
  }
  function ok(result){assert.ok(result.status===200||result.status===201,JSON.stringify(result.body));return result.body;}
  token=ok(await call('/api/pair',{code:'INTEROPERABILITY'})).token;
  const agent=ok(await call('/api/agents/pair',{root})).agent;
  ok(await call('/api/provider',{provider:'openai',model:'synthetic-A',apiKey:'not-a-real-key'}));
  ok(await call('/api/cognition',{learning:false,autoRoute:false,autoSprout:false,semanticRecall:false,autoDream:false}));
  t.after(async()=>{
    await new Promise(resolve=>{app.server.closeAllConnections();app.server.close(resolve);});
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));
    assert.ok(path.basename(directory).startsWith('ct-interoperability-'));
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {...app,root,directory,initial,agent,call,ok,generated,reviewed,native};
}

referenceTest('original whole-chain roundtrip preserves history, native faculties and new growth',async t=>{
  const f=await fixture(t);
  const before=await fs.readFile(path.join(f.root,'chain/rings.jsonl'));
  const selected=f.agent.faculties.filter(fac=>fac.source==='grown');
  assert.equal(selected.length,3);
  for(const faculty of selected){
    const text='metamaterial resonator linewidth calibration archive provenance cryogenic thermometry gradient';
    const expected=await original(f.root,'ops',{names:[faculty.name],text});
    const prepared=await engine({op:'prepare',root:f.root,input:text,loadout:[faculty.key],learning:false,recall:false});
    assert.deepEqual(prepared.computed,expected);
    if(faculty.effect?.type==='frame')assert.deepEqual(prepared.frames,[faculty.effect.text]);
  }
  f.ok(await f.call('/api/chat',{message:'Which specimen and calibration uncertainty did the original notebook record?'}));
  assert.ok((await fs.readFile(path.join(f.root,'chain/rings.jsonl'))).subarray(0,before.length).equals(before));
  const after=await original(f.root,'inspect');assert.equal(after.verified,true);
  for(const [filename,value] of Object.entries(f.initial.files))assert.equal(after.files[filename]?.sha256,value.sha256,filename+' stays unchanged with learning off');
  assert.ok(after.rings.some(r=>r.payload?.event==='web_chat_turn'));
  const nativeSeal=await original(f.root,'seal',{text:'The original engine resumes after ChainChat and preserves specimen Opal Lantern 318.'});
  assert.equal(nativeSeal.verified,true);
  await original(f.root,'grow');
  const reloaded=await engine({op:'inspect',root:f.root});
  const grown=reloaded.faculties.find(fac=>fac.name==='Interferometric Visibility Reasoning');
  assert.ok(grown?.equippable);
  const prepared=await engine({op:'prepare',root:f.root,input:'interferometric visibility calibration',loadout:[grown.key],learning:false,recall:false});
  assert.deepEqual(prepared.computed,await original(f.root,'ops',{names:[grown.name],text:'interferometric visibility calibration'}));
  const committed=await engine({op:'commit',root:f.root,expectedHead:prepared.head.hash,input:'quasiparticle anyonic braiding topological excitations fractional statistics',
    output:'The topic needs careful interpretation grounded in supplied evidence.',loadout:[],scores,assessment,growth:true,learning:true});
  assert.ok(committed.accepted);
  assert.ok(committed.growth.some(row=>row.grew),JSON.stringify(committed.growth));
  assert.equal((await original(f.root,'verify')).verified,true);
});

referenceTest('original frame and memory reach model calls across a provider model switch',async t=>{
  const f=await fixture(t);
  const frameFaculty=f.agent.faculties.find(fac=>fac.effect?.type==='frame');
  f.ok(await f.call('/api/loadout',{modalities:[String(frameFaculty.id)],senses:[]}));
  f.ok(await f.call('/api/chat',{message:'Recall the original notebook specimen and explain calibration uncertainty.'}));
  assert.ok(f.generated[0].args.system.includes(f.initial.memory));
  assert.ok(f.generated[0].args.system.includes(f.initial.frame));
  f.ok(await f.call('/api/provider',{provider:'openai',model:'synthetic-B',apiKey:'not-a-real-key'}));
  f.ok(await f.call('/api/chat',{message:'Use the same notebook, and state the uncertainty again.'}));
  assert.equal(f.generated[1].config.model,'synthetic-B');
  assert.ok(JSON.stringify(f.generated[1].args).includes('Opal Lantern 318'));
  assert.ok(f.generated[1].args.system.includes(f.initial.frame));
  f.ok(await f.call('/api/loadout',{modalities:[],senses:[]}));
  const unequipped=await engine({op:'prepare',root:f.root,input:'notebook provenance',loadout:[],learning:false,recall:false});
  assert.deepEqual(unequipped.frames,[]);
  assert.equal((await original(f.root,'verify')).verified,true);
});

referenceTest('original learned labeler survives pairing and a learning-frozen chat',async t=>{
  const f=await fixture(t);
  const trained=await original(f.root,'train_labeler');
  assert.equal(trained.adoption.adopted,true);
  assert.ok(trained.training.eval.distilled_f1>trained.training.eval.cheap_f1);
  const before=await fs.readFile(path.join(f.root,'registry/labeler.json'));
  const labels=JSON.parse(before).labels;
  assert.ok(Object.keys(labels).some(key=>key.startsWith('modality:')));
  f.ok(await f.call('/api/chat',{message:'Reason about metamaterial resonance calibration using learned local faculty routing.'}));
  assert.equal(digest(await fs.readFile(path.join(f.root,'registry/labeler.json'))),digest(before));
  const after=await original(f.root,'inspect');
  assert.equal(after.verified,true);
  assert.equal(after.files['registry/labeler.json'].sha256,digest(before));
  assert.ok(after.rings.some(r=>r.type==='operator'&&r.payload.operator==='labeler'));
});

referenceTest('confirmed lifecycle and Dream review retain user intent and relevant original memory',async t=>{
  const f=await fixture(t);
  const faculty=f.agent.faculties.find(fac=>fac.name==='Metamaterial Resonance Reasoning');
  f.ok(await f.call('/api/chat',{message:'The notebook specimen Opal Lantern 318 is our current task. I want temporary equipment changes to preserve its uncertain calibration.'}));
  f.ok(await f.call('/api/cognition',{learning:true}));
  const reasons=[
    'Temporarily rest resonance reasoning while I verify the Opal Lantern 318 calibration; retain its definition and history.',
    'Consolidate the Opal Lantern 318 task memories while preserving uncertainty and retaining prior evidence.'
  ];
  for(const [i,endpoint,body] of [
    [0,'/api/faculties/lifecycle',{action:'hibernate',key:faculty.key}],
    [1,'/api/maintenance',{action:'dream'}]
  ]){
    const calls=f.reviewed.length;
    const response=f.ok(await f.call(endpoint,{...body,reason:reasons[i],confirm:true}));
    assert.ok(response.ring);
    assert.equal(f.reviewed.length,calls+1);
    const semantic=JSON.stringify(f.reviewed.at(-1).args);
    assert.ok(semantic.includes(reasons[i]),'review must receive exact user control purpose');
    assert.ok(semantic.includes('0.25'),'review must receive relevant verified notebook context');
    assert.ok(semantic.includes('userConfirmed'),'review must identify explicit user confirmation');
  }
  assert.equal((await original(f.root,'verify')).verified,true);
});

referenceTest('original approved Python remains quarantined until local exact-source approval and changes revoke it',async t=>{
  const f=await fixture(t);
  const installed=await original(f.root,'install_authored_fixture');
  const sideEffect=installed.sideEffect;
  const exists=async file=>fs.access(file).then(()=>true,()=>false);
  assert.equal(await exists(sideEffect),false);
  await engine({op:'inspect',root:f.root});
  const before=await engine({op:'prepare',root:f.root,input:'sample',loadout:[installed.key],recall:false,learning:false});
  assert.ok(!Object.hasOwn(before.computed,installed.name));
  assert.equal(await exists(sideEffect),false,'pairing and preparation must not import pending Python');
  const cli=path.join(PRODUCT,'skill_interop.py');
  const unconfirmed=await python([cli,'approve-code','--root',f.root,'--sha256',installed.sha256]);
  assert.notEqual(unconfirmed.exitCode,0);
  assert.equal(await exists(sideEffect),false);
  const approved=await python([cli,'approve-code','--root',f.root,'--sha256',installed.sha256,'--confirm']);
  assert.equal(approved.exitCode,0,approved.stderr||approved.stdout);
  const prepared=await engine({op:'prepare',root:f.root,input:'sample',loadout:[installed.key],recall:false,learning:false});
  const native=await original(f.root,'authored_reference',{text:'sample'});
  assert.deepEqual(prepared.computed[installed.name],native.computed[installed.name]);
  assert.equal(prepared.computed[installed.name].fixture,'approved-native-sentinel');
  const copied=path.join(f.directory,'copied-original');
  await fs.cp(f.root,copied,{recursive:true});
  const copiedPrepared=await engine({op:'prepare',root:copied,input:'sample',loadout:[installed.key],recall:false,learning:false});
  assert.ok(!Object.hasOwn(copiedPrepared.computed,installed.name),'execution approval cannot be copied to another root');
  await fs.appendFile(path.join(f.root,'active_ops.py'),'\n# Changed reviewed module bytes.\n');
  const changed=await engine({op:'prepare',root:f.root,input:'sample',loadout:[installed.key],recall:false,learning:false});
  assert.ok(!Object.hasOwn(changed.computed,installed.name),'source changes invalidate prior approval');
  assert.equal((await original(f.root,'verify')).verified,true);
});

referenceTest('complete faculty pack crosses original and bundled engines without losing mechanisms or lineage',async t=>{
  const f=await fixture(t);
  await original(f.root,'set_effect',{name:'Metamaterial Resonance Reasoning',effectType:'hint',value:'partial'});
  const trained=await original(f.root,'train_labeler');
  assert.equal(trained.adoption.adopted,true);
  const source=trained.snapshot;
  const keys=f.agent.faculties.filter(fac=>fac.source==='grown').map(fac=>fac.key);
  const packFile=path.join(f.directory,'original-complete.json');
  await companion(f.root,ORIGINAL,'export',['--keys',...keys,'--out',packFile]);
  const pack=JSON.parse(await fs.readFile(packFile,'utf8'));
  assert.equal(pack.pack_format,1);assert.equal(pack.interaction_portability.format,1);
  assert.ok(pack.interaction_portability.entries.some(entry=>entry.learnedState.extractorHead));
  const recipient=path.join(f.directory,'recipient');
  await original(recipient,'initialize',{faculties:false});
  await original(recipient,'grow',{name:'Recipient Prior Interferometry'});
  const before=await fs.readFile(path.join(recipient,'chain/rings.jsonl'));
  const imported=await importComplete(recipient,path.join(PRODUCT,'engine/proof-of-interaction'),packFile,f.directory,'bundled');
  assert.equal(imported.imported.length,3);
  assert.ok((await fs.readFile(path.join(recipient,'chain/rings.jsonl'))).subarray(0,before.length).equals(before));
  const target=await original(recipient,'inspect');assert.equal(target.verified,true);
  assertFacultyMechanisms(source,target);
  assert.notEqual(definitions(source)['Metamaterial Resonance Reasoning'].id,definitions(target)['Metamaterial Resonance Reasoning'].id);
  assert.equal(await fs.access(path.join(recipient,'registry/labeler.json')).then(()=>true,()=>false),false,'donor learned head is retained without global activation');
  const side=JSON.parse(await fs.readFile(path.join(recipient,'registry/interaction_portability.json'),'utf8'));
  for(const entry of pack.interaction_portability.entries){
    const row=Object.values(side.entries).flat().find(row=>row.sourceKey===entry.key);
    assert.deepEqual(row.entry,entry,'exact original definition and learned state remain in sealed lineage');
  }
  const returnFile=path.join(f.directory,'return-complete.json');
  await companion(recipient,path.join(PRODUCT,'engine/proof-of-interaction'),'export',['--keys',...imported.imported.map(item=>item.key),'--out',returnFile]);
  const returnedPack=JSON.parse(await fs.readFile(returnFile,'utf8'));
  assert.ok(returnedPack.interaction_portability.entries.every(entry=>entry.lineage.length>=1));
  const destination=path.join(f.directory,'returned-original');
  await original(destination,'initialize',{faculties:false});
  const importedBack=await importComplete(destination,ORIGINAL,returnFile,f.directory,'original');
  assert.equal(importedBack.imported.length,3);
  const returned=await original(destination,'inspect');assert.equal(returned.verified,true);
  assertFacultyMechanisms(source,returned);
  const input='metamaterial splitring resonance archive provenance cryogenic thermometry gradient';
  const names=Object.keys(definitions(source));
  assert.deepEqual(await original(destination,'ops',{names,text:input}),await original(f.root,'ops',{names,text:input}));
  // Unmodified native import still accepts the legacy projection. Its known
  // reduced-fidelity semantics remain distinct from companion import.
  const legacy=path.join(f.directory,'legacy-original');await original(legacy,'initialize',{faculties:false});
  const legacyResult=await original(legacy,'legacy_import',{pack:returnedPack});
  assert.equal(legacyResult.report.errors.length,0);
  assert.ok(legacyResult.report.imported.length>0);
  assert.equal(legacyResult.snapshot.verified,true);
});

referenceTest('portable authored source stays inert until materialized, locally approved and deliberately equipped',async t=>{
  const f=await fixture(t);
  const authored=await original(f.root,'install_authored_fixture');
  const source=await original(f.root,'inspect');
  const proposal=source.emergent.faculties.find(entry=>entry.name==='Inert Test Operator');
  const emergent=source.emergent.faculties.find(entry=>entry.name==='Ocean Vorticity Sensing');
  const packFile=path.join(f.directory,'inert-source-pack.json');
  await companion(f.root,ORIGINAL,'export',['--keys',authored.key,'emergent:'+proposal.eid,'emergent:'+emergent.eid,'--out',packFile]);
  assert.equal(await fs.access(authored.sideEffect).then(()=>true,()=>false),false,'export never imports donor code');
  const pack=JSON.parse(await fs.readFile(packFile,'utf8'));
  assert.ok(pack.interaction_portability.artifacts.some(a=>a.kind==='authored-module'));
  assert.ok(pack.interaction_portability.entries.some(e=>e.artifacts.some(a=>a.kind==='authored-source')));
  const root=path.join(f.directory,'inert-recipient');await original(root,'initialize',{faculties:false});
  const imported=await importComplete(root,ORIGINAL,packFile,f.directory,'inert');
  assert.equal(imported.imported.length,3);
  assert.ok(imported.report.portability.quarantinedCodeCount>=2);
  assert.equal(await fs.access(path.join(root,'active_ops.py')).then(()=>true,()=>false),false);
  assert.equal(await fs.access(path.join(root,'chain/operator-approval.json')).then(()=>true,()=>false),false);
  const snapshot=await original(root,'inspect');assert.equal(snapshot.verified,true);
  const installed=definitions(snapshot)[authored.name];assert.equal(installed.status,'dormant');
  assert.ok(installed.portable_quarantine);
  const computed=await original(root,'ops',{names:[authored.name],text:'sample'});
  assert.deepEqual(computed,{});
  const module=pack.interaction_portability.artifacts.find(a=>a.kind==='authored-module');
  const materialized=await companion(root,ORIGINAL,'materialize-code',['--sha256',module.sha256,'--confirm']);
  assert.equal(materialized.materialized,true);assert.equal(materialized.approved,false);
  assert.equal(digest(await fs.readFile(path.join(root,'active_ops.py'))),module.sha256);
  const transferred=imported.imported.find(item=>item.name===authored.name);
  const beforeApproval=await engine({op:'prepare',root,input:'sample',loadout:[transferred.key],learning:false,recall:false});
  assert.ok(!Object.hasOwn(beforeApproval.computed,authored.name));
  assert.equal(await fs.access(path.join(root,'AUTHORED_IMPORT_SENTINEL')).then(()=>true,()=>false),false);
  await companion(root,ORIGINAL,'approve-code',['--sha256',module.sha256,'--confirm']);
  const manifest=JSON.parse(await fs.readFile(path.join(root,'chain/operator-approval.json'),'utf8'));
  assert.equal(path.resolve(manifest.engineDirectory),ORIGINAL,'approval binds the independently selected original runtime');
  const approved=await engine({op:'prepare',root,input:'sample',loadout:[transferred.key],learning:false,recall:false});
  const reference=await original(root,'authored_reference',{text:'sample'});
  assert.deepEqual(approved.computed[authored.name],reference.computed[authored.name]);
  f.ok(await f.call('/api/agents/pair',{root}));
  f.ok(await f.call('/api/cognition',{learning:false,autoRoute:false,autoSprout:false,semanticRecall:false,autoDream:false}));
  f.ok(await f.call('/api/loadout',{modalities:[],senses:[String(transferred.id)]}));
  f.ok(await f.call('/api/chat',{message:'sample'}));
  assert.ok(f.generated.at(-1).args.system.includes('approved-native-sentinel'));
  // A deliberate local edit introduces a benign dependency. Approval must bind
  // it as well as the module, and a later dependency-only edit must revoke it.
  const dependency=path.join(root,'interop_dependency.py');
  await fs.writeFile(dependency,'VALUE = 1\n');
  await fs.appendFile(path.join(root,'active_ops.py'),'\nimport interop_dependency\n');
  const editedDigest=digest(await fs.readFile(path.join(root,'active_ops.py')));
  await companion(root,ORIGINAL,'approve-code',['--sha256',editedDigest,'--confirm']);
  const withDependency=await engine({op:'prepare',root,input:'sample',loadout:[transferred.key],learning:false,recall:false});
  assert.equal(withDependency.computed[authored.name].fixture,'approved-native-sentinel');
  await fs.writeFile(dependency,'VALUE = 2\n');
  const changedDependency=await engine({op:'prepare',root,input:'sample',loadout:[transferred.key],learning:false,recall:false});
  assert.ok(!Object.hasOwn(changedDependency.computed,authored.name));
  assert.equal((await original(root,'verify')).verified,true);
});

referenceTest('HTTP faculty exchange preserves the complete pack for return to the original skill',async t=>{
  const f=await fixture(t);
  const source=await original(f.root,'inspect');
  const sourceKeys=f.agent.faculties.filter(fac=>fac.source==='grown').map(fac=>fac.key);
  const packFile=path.join(f.directory,'http-source.json');
  // Exercise the documented global argument order as an external CLI user.
  const exported=await python([path.join(PRODUCT,'skill_interop.py'),'--root',f.root,'--engine',ORIGINAL,'export','--keys',...sourceKeys,'--out',packFile]);
  assert.equal(exported.exitCode,0,exported.stderr||exported.stdout);
  const pack=JSON.parse(await fs.readFile(packFile,'utf8'));
  const recipient=path.join(f.directory,'http-recipient');
  await original(recipient,'initialize',{faculties:false});
  f.ok(await f.call('/api/agents/pair',{root:recipient}));
  f.ok(await f.call('/api/cognition',{learning:false,autoRoute:false,autoSprout:false,semanticRecall:false,autoDream:false}));
  const before=await fs.readFile(path.join(recipient,'chain/rings.jsonl'));
  const preview=f.ok(await f.call('/api/faculties/preview',{pack}));
  assert.ok((await fs.readFile(path.join(recipient,'chain/rings.jsonl'))).equals(before));
  const imported=f.ok(await f.call('/api/faculties/import',{pack,expectedHead:preview.head.hash,planHash:preview.planHash,confirm:true}));
  assert.equal(imported.imported.length,sourceKeys.length);
  const target=await original(recipient,'inspect');assertFacultyMechanisms(source,target);
  const frame=imported.imported.find(row=>row.name==='Archive Provenance Reasoning');
  const op=imported.imported.find(row=>row.name==='Metamaterial Resonance Reasoning');
  f.ok(await f.call('/api/loadout',{modalities:[String(frame.id),String(op.id)],senses:[]}));
  f.ok(await f.call('/api/chat',{message:'Please compare metamaterial resonator linewidth calibration and archive provenance.'}));
  assert.ok(f.generated.at(-1).args.system.includes(f.initial.frame));
  assert.ok(f.generated.at(-1).args.system.includes('Metamaterial Resonance Reasoning'));
  const back=f.ok(await f.call('/api/faculties/export',{name:'HTTP Roundtrip',keys:imported.imported.map(row=>row.key)}));
  assert.equal(back.pack.interaction_portability.format,1);
  const returnedFile=path.join(f.directory,'http-return.json');await fs.writeFile(returnedFile,JSON.stringify(back.pack));
  const finalRoot=path.join(f.directory,'http-returned-original');await original(finalRoot,'initialize',{faculties:false});
  await importComplete(finalRoot,ORIGINAL,returnedFile,f.directory,'http-return');
  const result=await original(finalRoot,'inspect');assert.equal(result.verified,true);assertFacultyMechanisms(source,result);
});
