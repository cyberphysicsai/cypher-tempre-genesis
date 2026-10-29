/** Real HTTP bridge + real, unmodified Python engine; only model calls are mocked. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../server.mjs";
import { FRUITS, DIMENSIONS } from "../lib/providers.mjs";
import { engine as canonicalEngine } from "../lib/engine.mjs";

const product = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python =
  process.env.CT_CHAT_PYTHON ||
  (process.platform === "win32" ? "python" : "python3");
const exec = promisify(execFile);
const answer =
  "We can consider the question patiently and clearly, and acknowledge uncertainty where information is missing.";
const reviewResult = () => ({
  approved: true,
  decision: "approve",
  scores: Object.fromEntries(DIMENSIONS.map((k) => [k, 240])),
  fruits: Object.fromEntries(FRUITS.map((k) => [k, 240])),
  rationale:
    "The response is honest, patient, kind, and promotes understanding.",
});
const rings = async (root) =>
  (await fs.readFile(path.join(root, "chain", "rings.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const chatRings = async (root) =>
  (await rings(root)).filter((r) => r.payload?.event === "web_chat_turn");

async function start(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ct-chat-integration-"),
  );
  const generated = [],
    reviewed = [];
  const app = await createApp({
    licenseConfig: { mode: "holdings", required: false },
    dataDir,
    pairingCode: "INTEGRATION-ONLY",
    engine: overrides.engine,
    generate: async (config, args) => {
      generated.push({ config, args });
      return overrides.generate
        ? overrides.generate(config, args)
        : { text: answer, usage: {} };
    },
    review: async (config, args) => {
      reviewed.push({ config, args });
      return overrides.review ? overrides.review(config, args) : reviewResult();
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let token;
  t.after(async () => {
    await new Promise((resolve) => {
      app.server.closeAllConnections();
      app.server.close(resolve);
    });
    const resolved = path.resolve(dataDir);
    assert.ok(
      resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
        path.basename(resolved).startsWith("ct-chat-integration-"),
    );
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const call = async (endpoint, payload) => {
    const response = await fetch(base + endpoint, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        ...(payload === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const paired = await call("/api/pair", { code: "INTEGRATION-ONLY" });
  assert.equal(paired.status, 200);
  token = paired.body.token;
  const created = await call("/api/agents", { name: "Integration Agent" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const configured = await call("/api/provider", {
    provider: "openai",
    model: "mock-model-a",
    apiKey: "integration-memory-only-key",
  });
  assert.equal(configured.status, 200);
  return {
    ...app,
    call,
    dataDir,
    generated,
    reviewed,
    initial: created.body,
    root: created.body.agent.root,
  };
}

test(
  "real engine: genesis, equipped operators, model switch and original CLI verification",
  { timeout: 300000 },
  async (t) => {
    const f = await start(t);
    assert.deepEqual(f.initial.agent.genesis.covenant, FRUITS);
    assert.equal(f.initial.agent.height, 1);
    const genesisBytes = await fs.readFile(
      path.join(f.root, "chain", "rings.jsonl"),
    );
    const equipped = await f.call("/api/loadout", {
      modalities: ["2"],
      senses: ["5"],
    });
    assert.equal(equipped.status, 200, JSON.stringify(equipped.body));
    const first = await f.call("/api/chat", {
      message: "Help me reason patiently about this question.",
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.message.content, answer);
    assert.equal(first.body.message.gate.approved, true);
    const firstRings = await chatRings(f.root);
    assert.equal(firstRings.length, 1);
    assert.equal(
      firstRings[0].payload.exchanges[0].input,
      "Help me reason patiently about this question.",
    );
    assert.equal(firstRings[0].payload.exchanges[0].output, answer);
    assert.deepEqual(firstRings[0].payload.labels.equipped, [
      "modality:2",
      "sense:5",
    ]);
    assert.ok(
      Object.hasOwn(
        firstRings[0].payload.labels.computed,
        "Salience Anchoring",
      ),
    );
    assert.ok(
      (await fs.readFile(path.join(f.root, "chain", "rings.jsonl")))
        .subarray(0, genesisBytes.length)
        .equals(genesisBytes),
    );
    assert.ok(
      first.body.state.agent.faculties.length >
        f.initial.agent.faculties.length,
      "Native Cambium growth appears in the live catalogue.",
    );
    assert.equal(
      (
        await f.call("/api/provider", {
          provider: "gemini",
          model: "mock-model-b",
          apiKey: "second-memory-only-key",
        })
      ).status,
      200,
    );
    const second = await f.call("/api/chat", {
      message: "What could we consider next?",
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.state.agent.id, f.initial.agent.id);
    assert.equal(second.body.state.agent.root, f.root);
    const sealed = await chatRings(f.root);
    assert.equal(sealed.length, 2);
    assert.equal(sealed[0].payload.exchanges[0].model.model, "mock-model-a");
    assert.equal(sealed[1].payload.exchanges[0].model.model, "mock-model-b");
    const verified = await f.call("/api/verify", {});
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.verified, true);
    const canonical = await exec(
      python,
      [
        path.join(product, "engine", "proof-of-interaction", "timechain.py"),
        "verify",
        "--root",
        f.root,
      ],
      {
        cwd: product,
        windowsHide: true,
        timeout: 60000,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    assert.match(canonical.stdout, /PASS/);
  },
);

test(
  "real native PoI rejects low consistency despite high fruitage scores without altering chain",
  { timeout: 300000 },
  async (t) => {
    const f = await start(t, {
      review: () => {
        const result = reviewResult();
        result.scores.consistency = 1;
        return result;
      },
    });
    const before = await fs.readFile(path.join(f.root, "chain", "rings.jsonl"));
    const rejected = await f.call("/api/chat", {
      message: "Help me reason patiently about this question.",
    });
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, "POI_REJECTED");
    assert.equal(rejected.body.message, undefined);
    assert.ok(
      before.equals(
        await fs.readFile(path.join(f.root, "chain", "rings.jsonl")),
      ),
    );
    assert.equal((await f.call("/api/state")).body.pending.count, 0);
  },
);

test(
  "an existing original-skill genesis pairs unchanged and remains readable after chat append",
  { timeout: 300000 },
  async (t) => {
    const f = await start(t);
    const existing = path.join(f.dataDir, "original-skill-agent");
    await fs.mkdir(path.join(existing, "registry"), { recursive: true });
    for (const name of ["modalities.json", "senses.json"])
      await fs.copyFile(
        path.join(product, "engine", "proof-of-interaction", "registry", name),
        path.join(existing, "registry", name),
      );
    const cli = path.join(
      product,
      "engine",
      "proof-of-interaction",
      "timechain.py",
    );
    const options = {
      cwd: product,
      windowsHide: true,
      timeout: 60000,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    };
    await exec(
      python,
      [cli, "init", "--name", "Original Skill Agent", "--root", existing],
      options,
    );
    const before = await fs.readFile(
      path.join(existing, "chain", "rings.jsonl"),
    );
    const paired = await f.call("/api/agents/pair", { root: existing });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    assert.equal(paired.body.agent.name, "Original Skill Agent");
    assert.ok(
      before.equals(
        await fs.readFile(path.join(existing, "chain", "rings.jsonl")),
      ),
      "Pairing itself is read-only.",
    );
    const response = await f.call("/api/chat", {
      message: "Help me consider this question with kindness.",
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const after = await fs.readFile(
      path.join(existing, "chain", "rings.jsonl"),
    );
    assert.ok(after.subarray(0, before.length).equals(before));
    assert.match(
      (await exec(python, [cli, "verify", "--root", existing], options)).stdout,
      /PASS/,
    );
  },
);

test(
  "real byte-mode pending flush seals two complete exchanges into one canonical turn",
  { timeout: 300000 },
  async (t) => {
    const f = await start(t);
    assert.equal(
      (
        await f.call("/api/settings", {
          continuum: { enabled: true, mode: "bytes", targetBytes: 16384 },
        })
      ).status,
      200,
    );
    for (const question of [
      "Help me consider this question with kindness.",
      "What could we consider next with patience?",
    ]) {
      const response = await f.call("/api/chat", { message: question });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.message.pending, true);
      assert.equal(response.body.message.ring, null);
    }
    assert.equal((await chatRings(f.root)).length, 0);
    const flush = await f.call("/api/continuum/flush", {});
    assert.equal(flush.status, 200, JSON.stringify(flush.body));
    assert.equal(flush.body.state.pending.count, 0);
    const blocks = await chatRings(f.root);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].payload.exchanges.length, 2);
    assert.equal(blocks[0].payload.block_policy.mode, "batch");
    assert.equal(
      f.reviewed.length,
      4,
      "Every pending answer is reviewed again on explicit flush.",
    );
    assert.equal((await f.call("/api/verify", {})).body.verified, true);
  },
);

test(
  "real Chronosynaptic collapse stores all three model-produced perspectives and a synthesis",
  { timeout: 300000 },
  async (t) => {
    const f = await start(t);
    assert.equal(
      (
        await f.call("/api/settings", {
          fork: true,
          perspectives: 3,
          archetypes: ["2", "5", "6"],
        })
      ).status,
      200,
    );
    const response = await f.call("/api/chat", {
      message:
        "Help me consider this question patiently from several perspectives.",
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.message.perspectives.length, 3);
    assert.equal(f.generated.length, 4);
    assert.equal(f.reviewed.length, 4);
    const sealed = (await chatRings(f.root))[0];
    const notes = sealed.payload.exchanges[0].chronosynaptic;
    assert.equal(notes.collapsed_from, 3);
    assert.equal(notes.perspectives.length, 3);
    assert.equal(notes.rejected_perspectives.length, 2);
    assert.equal(sealed.payload.exchanges[0].output, answer);
    assert.equal((await f.call("/api/verify", {})).body.verified, true);
  },
);

test(
  "a lost real commit receipt recovers on flush without duplicating a conversation ring",
  { timeout: 300000 },
  async (t) => {
    let loseReceipt = true;
    const f = await start(t, {
      engine: async (request) => {
        const result = await canonicalEngine(request);
        if (request.op === "commit" && loseReceipt) {
          loseReceipt = false;
          throw Object.assign(
            new Error("Simulated transport loss after a real append."),
            { code: "ENGINE_PROTOCOL", status: 422 },
          );
        }
        return result;
      },
    });
    const response = await f.call("/api/chat", {
      message: "Help me reason patiently about this question.",
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.code, "ENGINE_PROTOCOL");
    const before = await chatRings(f.root);
    assert.equal(before.length, 1);
    assert.equal((await f.call("/api/state")).body.pending.count, 1);
    const flush = await f.call("/api/continuum/flush", {});
    assert.equal(flush.status, 200, JSON.stringify(flush.body));
    assert.equal(flush.body.replayedCommit, true);
    const after = await chatRings(f.root);
    assert.equal(after.length, 1);
    assert.equal(after[0].ring_hash, before[0].ring_hash);
    assert.equal(flush.body.state.pending.count, 0);
    assert.equal(f.reviewed.length, 1);
    assert.equal((await f.call("/api/verify", {})).body.verified, true);
  },
);

test(
  "real Continuum stores source blocks as data with reviewed findings and UTF-8 ceilings",
  { timeout: 300000 },
  async (t) => {
    const f = await start(t);
    const source =
      "Patience and kindness guide this inquiry.\nWe acknowledge uncertainty while considering the available information.\n";
    const response = await f.call("/api/continuum", {
      name: "reflection-notes.txt",
      text: source,
      targetBytes: 64,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = (await rings(f.root)).filter(
      (r) => r.ring_type === "continuum",
    );
    assert.ok(data.length >= 2);
    assert.equal(data.map((r) => r.payload.data.content).join(""), source);
    assert.ok(
      data.every(
        (r) => Buffer.byteLength(r.payload.data.content, "utf8") <= 64,
      ),
    );
    assert.ok(data.every((r) => r.payload.ingestion_review?.approved === true));
    assert.ok(
      data.every((r) =>
        r.payload.state?.findings?.some((finding) => finding.includes(answer)),
      ),
      "Every committed source block has a reviewed public finding in canonical Continuum state.",
    );
    assert.equal((await f.call("/api/verify", {})).body.verified, true);
  },
);

const megabyteSource = () => {
  const sentence =
    "We consider each question with patience, kindness, and care, while acknowledging uncertainty.\n";
  return sentence.repeat(Math.ceil((1024 * 1024 + 4096) / sentence.length));
};

test(
  "a source larger than one MiB keeps its two MiB commitment boundary across reviewed semantic windows",
  { timeout: 300000 },
  async (t) => {
    let modelCalls = 0;
    let reviewCalls = 0;
    const ingests = [];
    const f = await start(t, {
      generate: async () => {
        modelCalls++;
        return { text: answer, usage: {} };
      },
      review: async () => {
        reviewCalls++;
        return reviewResult();
      },
      engine: async (request) => {
        if (request.op === "ingest") {
          ingests.push({
            modelCalls,
            reviewCalls,
            bytes: Buffer.byteLength(request.text, "utf8"),
          });
        }
        return canonicalEngine(request);
      },
    });
    const source = megabyteSource();
    const sourceBytes = Buffer.byteLength(source, "utf8");
    assert.ok(sourceBytes > 1024 * 1024 && sourceBytes < 2 * 1024 * 1024);
    const response = await f.call("/api/continuum", {
      name: "large-reflection-notes.txt",
      text: source,
      targetBytes: 2 * 1024 * 1024,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(
      modelCalls > 2,
      "A large storage block must be analyzed in bounded semantic windows.",
    );
    assert.equal(
      reviewCalls,
      modelCalls,
      "Every generated window or reduction summary must pass an independent review.",
    );
    assert.deepEqual(
      ingests,
      [{ modelCalls, reviewCalls, bytes: sourceBytes }],
      "The complete block is ingested only after all window and reduction reviews finish.",
    );
    const data = (await rings(f.root)).filter(
      (ring) => ring.ring_type === "continuum",
    );
    assert.equal(
      data.length,
      1,
      "Semantic windows must not override the requested storage boundary.",
    );
    assert.equal(data[0].payload.data.content, source);
    assert.equal(data[0].payload.byte_policy.target_bytes, 2 * 1024 * 1024);
    assert.ok(
      data[0].payload.state.findings.some((finding) =>
        finding.includes(answer),
      ),
    );
    assert.equal((await f.call("/api/verify", {})).body.verified, true);
  },
);

test(
  "rejection of a later semantic window leaves the whole chosen source block uncommitted",
  { timeout: 300000 },
  async (t) => {
    let reviews = 0;
    let ingests = 0;
    const f = await start(t, {
      review: async () => {
        reviews++;
        const assessment = reviewResult();
        if (reviews === 2) assessment.fruits.kindness = 1;
        return assessment;
      },
      engine: async (request) => {
        if (request.op === "ingest") ingests++;
        return canonicalEngine(request);
      },
    });
    const before = await fs.readFile(path.join(f.root, "chain", "rings.jsonl"));
    const response = await f.call("/api/continuum", {
      name: "held-large-source.txt",
      text: megabyteSource(),
      targetBytes: 2 * 1024 * 1024,
    });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.equal(response.body.code, "COVENANT_REJECTED");
    assert.equal(reviews, 2);
    assert.equal(
      ingests,
      0,
      "Even the first accepted semantic window must wait for the complete chosen block.",
    );
    assert.ok(
      before.equals(
        await fs.readFile(path.join(f.root, "chain", "rings.jsonl")),
      ),
      "Neither a task-open nor a source ring is appended before all reviews pass.",
    );
    assert.equal((await f.call("/api/verify", {})).body.verified, true);
  },
);
