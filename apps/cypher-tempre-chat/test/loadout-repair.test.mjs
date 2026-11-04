/** Equipment repair uses native catalogue authority without modifying history. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { engine } from '../lib/engine.mjs';
import { defaultLoadout, reconcileLoadout } from '../lib/state.mjs';
import { DIMENSIONS, FRUITS } from '../lib/providers.mjs';

const PRODUCT = path.resolve(import.meta.dirname, '..');
const nativeSource = path.resolve(process.env.CT_ORIGINAL_SKILL || path.join(PRODUCT, 'engine/proof-of-interaction'));
const SOURCE = await fs.access(path.join(nativeSource, 'timechain.py')).then(() => nativeSource,
  () => path.join(PRODUCT, 'engine/proof-of-interaction'));
const answer = 'Hello! I am Catalogue Fixture, a Cypher Tempre conversational assistant. I can explore questions carefully and acknowledge uncertainty.';
const assessment = () => ({ approved: true, decision: 'approve', usedRings: [],
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])),
  rationale: 'The configured identity supports a concise, patient and honest introduction.' });

test('initial equipment intersects the actual base catalogue and excludes unavailable, dormant and newly learned faculties', () => {
  const catalogue = [
    { kind: 'modality', id: 2, key: 'modality:2', source: 'base', equippable: true },
    { kind: 'modality', id: 5, key: 'modality:5', source: 'base', equippable: true, dormant: true },
    { kind: 'modality', id: 37, key: 'modality:37', source: 'grown', equippable: true },
    { kind: 'sense', id: 5, key: 'sense:5', source: 'base', equippable: false },
    { kind: 'sense', id: 10, key: 'sense:10', source: 'base', equippable: true },
    { kind: 'sense', id: 84, key: 'emergent:84', source: 'emergent', equippable: false, requiresLocalCodeReview: true },
  ];
  assert.deepEqual(defaultLoadout(catalogue), { modalities: ['2'], senses: ['10'] });
  assert.deepEqual(defaultLoadout(), { modalities: [], senses: [] });
  const previous = { modalities: ['modality:2', '2', '5', '37', 'unknown'], senses: ['5', 'sense:10', '84'] };
  const repaired = reconcileLoadout(previous, catalogue);
  // An explicitly selected dormant definition remains native-equippable;
  // this does not clear code quarantine or grant local execution approval.
  assert.deepEqual(repaired.loadout, { modalities: ['modality:2', '5', '37'], senses: ['sense:10'] });
  assert.deepEqual(repaired.removed, { modalities: ['unknown'], senses: ['5', '84'] });
  assert.equal(repaired.changed, true);
  assert.deepEqual(previous.modalities, ['modality:2', '2', '5', '37', 'unknown']);
  assert.equal(reconcileLoadout(repaired.loadout, catalogue).changed, false);
});

async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-loadout-repair-')));
  const root = path.join(directory, 'custom-chain');
  const source = `import contextlib,io,json,sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom timechain import Timechain\nroot=Path(sys.argv[2]);(root/'registry').mkdir(parents=True)\nfor name in ('modalities','senses'):\n data=json.loads((Path(sys.argv[1])/'registry'/(name+'.json')).read_text(encoding='utf-8'));data[name]=data[name][:2];(root/'registry'/(name+'.json')).write_text(json.dumps(data),encoding='utf-8')\nwith contextlib.redirect_stdout(io.StringIO()):\n tc=Timechain(root);tc.genesis('Catalogue Fixture')\nassert tc.verify()[0]\nprint('verified')`;
  await promisify(execFile)(process.env.CT_CHAT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-c', source, SOURCE, root], { cwd: PRODUCT, windowsHide: true, timeout: 30000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
  const original = await fs.readFile(path.join(root, 'chain/rings.jsonl'));
  const registryBytes = Object.fromEntries(await Promise.all(['modalities.json', 'senses.json'].map(async name =>
    [name, await fs.readFile(path.join(root, 'registry', name))])));
  const app = await createApp({ dataDir: path.join(directory, 'application'), pairingCode: 'LOADOUT-REPAIR-FIXTURE',
    engine: async request => {
      const result = await engine(request);
      return options.inspect ? options.inspect(request, result) : result;
    },
    generate: async (_config, args) => {
      if (args.chainchatPurpose === 'utility') return { text: JSON.stringify({ queries: [], entities: [], shapes: ['narrow'],
        rings: [], useReplay: false, labels: { senses: [], modalities: [] } }) };
      return options.generate ? options.generate(args) : { text: answer };
    }, review: async () => assessment() });
  if (options.directAdd) {
    const pending = await app.store.add(root, 'Catalogue Fixture', true);
    assert.deepEqual(pending.loadout, { modalities: [], senses: [] });
    assert.equal(pending.loadoutDefaultsPending, true);
  }
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => {
    await app.closeRuntime(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('ct-loadout-repair-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let bearer;
  const call = async (endpoint, input, authenticated = true) => {
    const response = await fetch(base + endpoint, { method: input === undefined ? 'GET' : 'POST',
      headers: { origin: base, ...(authenticated && bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  bearer = (await call('/api/pair', { code: 'LOADOUT-REPAIR-FIXTURE' })).body.token;
  const paired = await call('/api/agents/pair', { root }); assert.equal(paired.status, 200, JSON.stringify(paired.body));
  const record = app.store.agents.find(agent => agent.root === root);
  assert.ok(record);
  if (options.provider !== false) assert.equal((await call('/api/provider', { provider: 'compatible', model: 'synthetic-fixture', baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'synthetic-fixture-key' })).status, 200);
  return { ...app, root, directory, original, registryBytes, call, record, paired };
}

test('a valid imported original catalogue pairs and chats with only its actual default faculties', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const native = await engine({ op: 'inspect', root: f.root });
  const expected = defaultLoadout(native.faculties);
  assert.deepEqual(f.paired.body.loadout, expected);
  assert.ok(expected.modalities.length + expected.senses.length > 0);
  assert.equal(f.paired.body.agent.verified, true);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'chain/rings.jsonl')), f.original);
  for (const [name, bytes] of Object.entries(f.registryBytes))
    assert.deepEqual(await fs.readFile(path.join(f.root, 'registry', name)), bytes);
  const response = await f.call('/api/chat', { message: 'Please introduce yourself' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.message.content, answer);
  assert.ok((await fs.readFile(path.join(f.root, 'chain/rings.jsonl'))).subarray(0, f.original.length).equals(f.original));
  assert.equal((await engine({ op: 'verify', root: f.root })).verified, true);
});

test('internal catalogue-less registration defers preferred equipment until a verified catalogue is available', { timeout: 180000 }, async t => {
  const f = await fixture(t, { directAdd: true });
  const current = await engine({ op: 'inspect', root: f.root });
  assert.deepEqual(f.record.loadout, defaultLoadout(current.faculties));
  assert.equal(Object.hasOwn(f.record, 'loadoutDefaultsPending'), false);
  assert.equal(f.paired.body.loadoutRepair, null);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'chain/rings.jsonl')), f.original);
});

test('refresh repairs persisted invalid IDs, retains valid choices, and never equips new faculties or rewrites history', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  f.record.loadout = { modalities: ['modality:2', '37'], senses: ['5', '10', '84'] };
  await f.store.save();
  const before = await fs.readFile(path.join(f.root, 'chain/rings.jsonl'));
  const state = await f.call('/api/state'); assert.equal(state.status, 200);
  assert.deepEqual(state.body.loadout, { modalities: ['modality:2'], senses: ['5'] });
  assert.deepEqual(state.body.loadoutRepair, { reason: 'unavailable-faculties', removed: { modalities: ['37'], senses: ['10', '84'] } });
  assert.deepEqual((await f.call('/api/state')).body.loadoutRepair, state.body.loadoutRepair);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'chain/rings.jsonl')), before);
  for (const [name, bytes] of Object.entries(f.registryBytes))
    assert.deepEqual(await fs.readFile(path.join(f.root, 'registry', name)), bytes);
  assert.deepEqual(JSON.parse(await fs.readFile(f.store.file, 'utf8'))[0].loadout, state.body.loadout);
  const active = await f.call('/api/chat', { message: 'Please introduce yourself' });
  assert.equal(active.status, 200, JSON.stringify(active.body));
  assert.equal((await engine({ op: 'verify', root: f.root })).verified, true);
});

test('authenticated equipment clearing remains available without a model and grants no new capability', { timeout: 180000 }, async t => {
  const f = await fixture(t, { provider: false });
  const before = await fs.readFile(path.join(f.root, 'chain/rings.jsonl'));
  const configure = await f.call('/api/loadout', { modalities: ['2'], senses: ['5'] });
  assert.equal(configure.status, 200, JSON.stringify(configure.body));
  const reset = await f.call('/api/loadout/reset', { confirm: true });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.deepEqual(reset.body.loadout, { modalities: [], senses: [] });
  assert.equal(reset.body.provider.configured, false);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'chain/rings.jsonl')), before);
});

test('state refresh defers equipment repair during generation and explicit clearing requires authenticated confirmed idle ownership', { timeout: 180000 }, async t => {
  let resolveGeneration, generationStarted;
  const started = new Promise(resolve => { generationStarted = resolve; });
  const wait = new Promise(resolve => { resolveGeneration = resolve; });
  let hideSelectedSense = false;
  const f = await fixture(t, { generate: async () => { generationStarted(); await wait; return { text: answer }; },
    inspect: (request, result) => request.op === 'inspect' && hideSelectedSense
      ? { ...result, faculties: result.faculties.filter(faculty => faculty.key !== 'sense:5') } : result });
  assert.equal((await f.call('/api/loadout/reset', { confirm: true }, false)).status, 401);
  assert.equal((await f.call('/api/loadout/reset', {})).body.code, 'LOADOUT_RESET_CONFIRM');
  assert.equal((await f.call('/api/loadout/reset', { confirm: true, id: 'other-agent' })).body.code, 'LOADOUT_RESET_INVALID');
  const selected = structuredClone(f.record.loadout);
  const running = f.call('/api/chat', { message: 'Please introduce yourself' });
  try {
    await started; hideSelectedSense = true;
    const during = await f.call('/api/state'); assert.equal(during.status, 200);
    assert.deepEqual(during.body.loadout, selected);
    assert.deepEqual(f.record.loadout, selected);
    const reset = await f.call('/api/loadout/reset', { confirm: true });
    assert.equal(reset.status, 409); assert.equal(reset.body.code, 'CHAIN_BUSY');
  } finally { resolveGeneration(); }
  const completed = await running; assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.deepEqual(completed.body.state.loadout.senses, selected.senses);
  const idle = await f.call('/api/state');
  assert.deepEqual(idle.body.loadout.senses, []);
  assert.deepEqual(idle.body.loadoutRepair.removed.senses, ['5']);
  const beforeReset = await fs.readFile(path.join(f.root, 'chain/rings.jsonl'));
  const cleared = await f.call('/api/loadout/reset', { confirm: true }); assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.loadout, { modalities: [], senses: [] });
  assert.equal(cleared.body.loadoutRepair, null);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'chain/rings.jsonl')), beforeReset);
});
