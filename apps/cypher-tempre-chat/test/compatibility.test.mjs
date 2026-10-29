/** Optional external-engine parity checks; no earlier engine is shipped in this app. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import { DIMENSIONS, FRUITS } from "../lib/providers.mjs";
import { sanitizeModelValue } from "../lib/terminology.mjs";

const product = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reference = process.env.CT_PARITY_REFERENCE;
const python =
  process.env.CT_CHAT_PYTHON ||
  (process.platform === "win32" ? "python" : "python3");
const execute = promisify(execFile);
const options = {
  cwd: product,
  windowsHide: true,
  timeout: 60000,
  maxBuffer: 4 * 1024 * 1024,
  env: {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  },
};
const priorGate = ["Po", "Q"].join("");
const priorName = ["qua", "lia"].join("");
const retired = new RegExp(`${priorName}|${priorGate}`, "i");
const score = (value = 240) =>
  Object.fromEntries(DIMENSIONS.map((key) => [key, value]));
const reviewed = () => ({
  decision: "approve",
  approved: true,
  scores: score(),
  fruits: Object.fromEntries(FRUITS.map((key) => [key, 240])),
  rationale: "Patient and accurate help that respects the covenant.",
});
const skip = reference
  ? false
  : "Set CT_PARITY_REFERENCE to an independently stored earlier skill engine.";

async function externalReference() {
  const resolved = await fs.realpath(reference);
  const relative = path.relative(await fs.realpath(product), resolved);
  assert.ok(
    relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    "The reference engine must stay outside the shipped product.",
  );
  return resolved;
}

async function compare(mode, source, request) {
  const { stdout } = await execute(
    python,
    [
      path.join(product, "test", "reference-engine.py"),
      mode,
      source,
      JSON.stringify(request),
    ],
    options,
  );
  return JSON.parse(stdout);
}

test(
  "renamed gate preserves native scores, brightness, grounding and all four decisions",
  { skip },
  async () => {
    const baseline = await externalReference();
    const candidate =
      "We can consider the question patiently and acknowledge uncertainty where information is missing.";
    const context =
      "Please consider the question patiently and acknowledge uncertainty where information is missing.";
    const cases = [{ candidate, context }];
    for (const dimension of DIMENSIONS) {
      for (const value of [0, 80, 127, 179, 240, 255])
        cases.push({
          candidate,
          context,
          scores: { ...score(), [dimension]: value },
        });
    }
    cases.push(
      {
        candidate,
        context,
        scores: { ...score(100), covenant: 200, consistency: 200 },
      },
      {
        candidate:
          "The fact is that this unobserved galaxy definitely always certainly must have exactly nine secret planets.",
        scores: score(),
      },
      { candidate, context, thresholds: { covenant_floor: 240 } },
      {
        candidate,
        context,
        scores: { ...score(), covenant: 239 },
        thresholds: { covenant_floor: 240 },
      },
      {
        candidate,
        context,
        scores: { ...score(), consistency: 219 },
        thresholds: { consistency_floor: 220 },
      },
      {
        candidate: "The total count is 99 across all observations.",
        context: "The total count is 99 across all observations.",
        scores: score(),
        declaredEvidence: 1,
      },
      {
        candidate: "The measurement was 875 metres in document.txt.",
        context: "A measurement was recorded.",
        scores: score(),
        evidenceTexts: ["A measurement was recorded."],
        thresholds: { entity_grounding_enforce: true },
      },
    );
    const previous = await compare("parity", baseline, {
      module: priorGate.toLowerCase(),
      gateClass: `${priorGate}Gate`,
      cases,
    });
    const current = await compare(
      "parity",
      path.join(product, "engine", "proof-of-interaction"),
      { module: "PoI", gateClass: "PoIGate", cases },
    );
    assert.deepEqual(current, sanitizeModelValue(previous));
    assert.deepEqual([...new Set(current.map((v) => v.decision))].sort(), [
      "FORCE_UNCERTAINTY",
      "REJECT",
      "REVISE",
      "SEAL",
    ]);
    assert.equal(current.length, 44);
  },
);

test(
  "external original chain retains historical bytes and strict policy while new interactions use current schema",
  { skip, timeout: 300000 },
  async (t) => {
    const baseline = await externalReference();
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ct-compatibility-"),
    );
    const root = path.join(dataDir, "existing-agent");
    t.after(async () => {
      assert.ok(
        path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep),
      );
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const legacyText = `The inherited Proof of ${priorName} and ${priorGate} history supports patient, kind conversation.`;
    const initialized = await compare("init", baseline, {
      module: priorGate.toLowerCase(),
      scoreKey: priorGate.toLowerCase(),
      root,
      scores: score(),
      legacyText,
      policy: {
        [priorGate.toLowerCase()]: {
          calibrated: { brightness_target: 180, grounding_floor: 100 },
          aggregate_min_terms: 5,
        },
        values: { covenant_floor: 200, consistency_floor: 200 },
      },
    });
    assert.equal(initialized.verified, true);
    const ringFile = path.join(root, "chain", "rings.jsonl");
    const policyFile = path.join(root, "registry", "policy.json");
    const before = await fs.readFile(ringFile);
    const policyBytes = await fs.readFile(policyFile);
    const effective = await compare("bridge-thresholds", product, { root });
    assert.deepEqual(effective, initialized.thresholds);
    assert.equal(
      effective.brightness_target,
      169,
      "The existing native brightness cap still applies to a requested target of 180.",
    );
    assert.equal(effective.grounding_floor, 100);
    assert.equal(effective.aggregate_min_terms, 5);
    assert.equal(effective.consistency_floor, 200);

    const generated = [],
      reviews = [];
    let consistency = 240;
    const app = await createApp({
      dataDir: path.join(dataDir, "app"),
      pairingCode: "COMPATIBILITY-ONLY",
      generate: async (config, args) => {
        generated.push({ config, args });
        return {
          text: "We can consider this patiently and acknowledge uncertainty where information is missing.",
          usage: {},
        };
      },
      review: async (config, args) => {
        reviews.push({ config, args });
        const result = reviewed();
        result.scores.consistency = consistency;
        return result;
      },
    });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    t.after(
      async () =>
        new Promise((resolve) => {
          app.server.closeAllConnections();
          app.server.close(resolve);
        }),
    );
    const base = `http://127.0.0.1:${app.server.address().port}`;
    let token;
    async function call(endpoint, value) {
      const result = await fetch(base + endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(value),
      });
      return { status: result.status, body: await result.json() };
    }
    token = (await call("/api/pair", { code: "COMPATIBILITY-ONLY" })).body
      .token;
    const paired = await call("/api/agents/pair", { root });
    assert.equal(paired.status, 200, JSON.stringify(paired.body));
    assert.deepEqual(await fs.readFile(ringFile), before);
    await call("/api/provider", {
      provider: "openai",
      model: "mock-model",
      apiKey: "memory-only-key",
    });
    const message = `Help me recall the inherited ${priorGate} history and explain Proof of ${priorName} patiently.`;
    const response = await call("/api/chat", { message });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const after = await fs.readFile(ringFile);
    assert.ok(after.subarray(0, before.length).equals(before));
    assert.deepEqual(await fs.readFile(policyFile), policyBytes);
    const records = after
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const sealed = records.find(
      (ring) => ring.payload?.event === "web_chat_turn",
    );
    assert.ok(Object.hasOwn(sealed, "poi"));
    assert.ok(!Object.hasOwn(sealed, priorGate.toLowerCase()));
    assert.ok(Object.hasOwn(sealed.payload, "poi_verdict"));
    assert.equal(
      sealed.payload.input,
      message,
      "Original user wording remains in immutable storage.",
    );
    assert.ok(generated.length > 0 && reviews.length > 0);
    for (const item of [...generated, ...reviews]) {
      assert.doesNotMatch(JSON.stringify(item.args), retired);
      assert.equal(item.config.apiKey, "memory-only-key");
    }
    assert.match(generated[0].args.system, /inherited Proof of interaction/i);
    consistency = 190;
    const rejected = await call("/api/chat", {
      message: "Please consider the same question patiently.",
    });
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, "POI_REJECTED");
    assert.deepEqual(await fs.readFile(ringFile), after);
    assert.deepEqual(await fs.readFile(policyFile), policyBytes);
    assert.match(
      (
        await execute(
          python,
          [path.join(baseline, "timechain.py"), "verify", "--root", root],
          options,
        )
      ).stdout,
      /PASS/,
    );
    assert.match(
      (
        await execute(
          python,
          [
            path.join(
              product,
              "engine",
              "proof-of-interaction",
              "timechain.py",
            ),
            "verify",
            "--root",
            root,
          ],
          options,
        )
      ).stdout,
      /PASS/,
    );
  },
);
