/** Faculty sharing through real HTTP and canonical engine, with model judgment mocked. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createApp } from "../server.mjs";
import { FRUITS, DIMENSIONS } from "../lib/providers.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function packHash(pack) {
  const fields = Object.fromEntries(
    ["name", "version", "domain", "author", "faculties"].map((key) => [
      key,
      pack[key],
    ]),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical(fields)), "utf8")
    .digest("hex");
}

function facultyPack() {
  const pack = {
    pack_format: 1,
    name: "ocean-lenses",
    version: "1.0.0",
    domain: "Ocean observation",
    author: "Sharing Agent",
    created_at: "2026-10-28T00:00:00Z",
    donor: {
      genesis_name: "Sharing Agent",
      chain_head_index: 12,
      chain_head_hash: "a".repeat(64),
    },
    faculties: [
      {
        kind: "sense",
        name: "Thermocline Salinity Gradient Sensing",
        function:
          "Distinguish thermocline, halocline, salinity, and bathymetry observations, flag calibration uncertainty and avoid extrapolating measured seawater density beyond instrument resolution.",
        category: "knowledge",
        seed_terms: ["thermocline", "halocline", "bathymetry"],
        status: "promoted",
        provenance: { origin: "grown", donor_id: 90 },
      },
    ],
  };
  pack.pack_sha256 = packHash(pack);
  return pack;
}

const assessment = () => ({
  approved: true,
  decision: "approve",
  scores: Object.fromEntries(DIMENSIONS.map((key) => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map((key) => [key, 240])),
  rationale:
    "The bounded lens supports careful, honest observations without replacing the genesis covenant.",
});

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ct-faculty-exchange-test-"),
  );
  const reviews = [];
  const app = await createApp({
    licenseConfig: { mode: "holdings", required: false },
    dataDir,
    pairingCode: "FACULTY-TEST",
    generate: async () => ({
      text: "We can consider the question patiently and clearly, and acknowledge uncertainty where information is missing.",
      usage: {},
    }),
    review: async (config, args) => {
      reviews.push(args);
      return options.review ? options.review(config, args) : assessment();
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
        path.basename(resolved).startsWith("ct-faculty-exchange-test-"),
    );
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const call = async (endpoint, payload, authenticated = true) => {
    const response = await fetch(base + endpoint, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        ...(payload === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(authenticated && token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const paired = await call("/api/pair", { code: "FACULTY-TEST" });
  assert.equal(paired.status, 200);
  token = paired.body.token;
  const created = await call("/api/agents", { name: "Receiving Agent" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const connected = await call("/api/provider", {
    provider: "openai",
    model: "mock-faculty-model",
    apiKey: "faculty-memory-only-key",
  });
  assert.equal(connected.status, 200);
  return { ...app, dataDir, root: created.body.agent.root, call, reviews };
}

async function snapshot(root) {
  const records = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else
        records.push([
          path.relative(root, filename),
          createHash("sha256")
            .update(await fs.readFile(filename))
            .digest("hex"),
        ]);
    }
  }
  await visit(root);
  return records.sort(([a], [b]) => a.localeCompare(b));
}

async function head(f) {
  return (await f.call("/api/state")).body.agent.head.hash;
}

test(
  "borrowed faculty review uses interaction terminology while the authenticated pack remains unchanged",
  { timeout: 300000 },
  async (t) => {
    const priorName = ["qua", "lia"].join("");
    const priorGate = ["Po", "Q"].join("");
    const retired = new RegExp(`${priorName}|${priorGate}`, "i");
    const f = await fixture(t);
    const pack = facultyPack();
    pack.faculties[0].function += ` Explain the earlier Proof of ${priorName} and ${priorGate} labels with care.`;
    pack.pack_sha256 = packHash(pack);
    const original = JSON.stringify(pack);
    const result = await f.call("/api/faculties/import", {
      pack,
      expectedHead: await head(f),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.reviews.length, 1);
    assert.doesNotMatch(JSON.stringify(f.reviews[0]), retired);
    assert.match(JSON.stringify(f.reviews[0]), /Proof of interaction/);
    assert.equal(JSON.stringify(pack), original);
    const state = (await f.call("/api/state")).body;
    const imported = state.agent.faculties.find(
      (item) => item.name === pack.faculties[0].name,
    );
    assert.ok(imported);
    const exported = await f.call("/api/faculties/export", {
      name: "roundtrip-lens",
      keys: [imported.key],
    });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(
      exported.body.pack.faculties[0].function,
      pack.faculties[0].function,
    );
    assert.equal(exported.body.pack.pack_sha256, packHash(exported.body.pack));
  },
);

test(
  "faculty preview verifies canonical pack content without model calls or agent mutation",
  { timeout: 300000 },
  async (t) => {
    const f = await fixture(t);
    const before = await snapshot(f.root);
    const pack = facultyPack();
    const result = await f.call("/api/faculties/preview", { pack });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(
      result.body.donorVerified,
      false,
      "A content checksum does not authenticate the claimed donor.",
    );
    assert.equal(f.reviews.length, 0);
    assert.deepEqual(await snapshot(f.root), before);
    assert.equal(
      (await f.call("/api/faculties/preview", { pack }, false)).status,
      401,
    );
  },
);

test(
  "tampered, malformed, oversized, path and executable pack metadata are rejected without mutation",
  { timeout: 300000 },
  async (t) => {
    const f = await fixture(t);
    const before = await snapshot(f.root);
    const tampered = facultyPack();
    tampered.faculties[0].function += " Modified after export.";
    const badPacks = [tampered];
    for (const mutate of [
      (p) => {
        p.faculties[0].kind = "execute";
      },
      (p) => {
        p.faculties[0].function = "x".repeat(801);
      },
      (p) => {
        p.faculties[0].category = "";
      },
      (p) => {
        p.faculties[0].seed_terms = ["x".repeat(100000)];
      },
      (p) => {
        p.faculties = Array.from({ length: 51 }, () =>
          structuredClone(p.faculties[0]),
        );
      },
      (p) => {
        p.faculties[0].effect = {
          type: "op",
          code: "import os; os.system('untrusted')",
        };
      },
      (p) => {
        p.faculties[0].provenance.path = "../../active_ops.py";
      },
      (p) => {
        p.root = "../../outside-agent";
      },
    ]) {
      const value = facultyPack();
      mutate(value);
      value.pack_sha256 = packHash(value);
      badPacks.push(value);
    }
    for (const pack of badPacks) {
      const response = await f.call("/api/faculties/preview", { pack });
      assert.ok(
        [400, 413, 422].includes(response.status),
        JSON.stringify(response.body),
      );
    }
    const partial = facultyPack();
    partial.faculties.push({
      ...structuredClone(partial.faculties[0]),
      name: "Broken later faculty",
      category: "",
    });
    partial.pack_sha256 = packHash(partial);
    const partialImport = await f.call("/api/faculties/import", {
      pack: partial,
      expectedHead: await head(f),
    });
    assert.ok(
      [400, 422].includes(partialImport.status),
      "A bad second faculty must not leave the first one imported.",
    );
    assert.equal(f.reviews.length, 0);
    assert.deepEqual(await snapshot(f.root), before);
  },
);

test(
  "a low fruitage import cannot change faculties or append an import ring",
  { timeout: 300000 },
  async (t) => {
    const f = await fixture(t, {
      review: () => {
        const result = assessment();
        result.fruits["self-control"] = 1;
        return result;
      },
    });
    const before = await snapshot(f.root);
    const pack = facultyPack();
    const result = await f.call("/api/faculties/import", {
      pack,
      expectedHead: await head(f),
      assessment: assessment(),
      force: true,
    });
    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.equal(result.body.code, "COVENANT_REJECTED");
    assert.equal(f.reviews.length, 1);
    const reviewed = JSON.stringify(f.reviews[0]);
    assert.ok(
      reviewed.includes(pack.faculties[0].function),
      "The full operational lens, not just its title, must be reviewed.",
    );
    assert.match(reviewed, /untrusted/i);
    assert.deepEqual(await snapshot(f.root), before);
  },
);

test(
  "native PoI and stale chain heads independently prevent faculty import",
  { timeout: 300000 },
  async (t) => {
    const f = await fixture(t, {
      review: () => {
        const result = assessment();
        result.scores.consistency = 1;
        return result;
      },
    });
    const before = await snapshot(f.root);
    const pack = facultyPack();
    const rejected = await f.call("/api/faculties/import", {
      pack,
      expectedHead: await head(f),
    });
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, "POI_REJECTED");
    assert.deepEqual(await snapshot(f.root), before);
    const stale = await f.call("/api/faculties/import", {
      pack,
      expectedHead: "0".repeat(64),
    });
    assert.ok([409, 422].includes(stale.status), JSON.stringify(stale.body));
    assert.equal(stale.body.code, "STALE_HEAD");
    assert.deepEqual(await snapshot(f.root), before);
  },
);

test(
  "reviewed imported senses become equippable and export as canonical packs without private memory",
  { timeout: 300000 },
  async (t) => {
    const f = await fixture(t);
    const privateMarker = "PRIVATE_MEMORY_NEVER_IN_A_FACULTY_PACK";
    const chatted = await f.call("/api/chat", {
      message: `Help me consider ${privateMarker} with patience.`,
    });
    assert.equal(chatted.status, 200, JSON.stringify(chatted.body));
    const pack = facultyPack();
    const imported = await f.call("/api/faculties/import", {
      pack,
      expectedHead: await head(f),
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const state = (await f.call("/api/state")).body;
    const sense = state.agent.faculties.find(
      (item) => item.name === pack.faculties[0].name,
    );
    assert.ok(
      sense,
      "The borrowed sense is in the recipient's live catalogue.",
    );
    assert.equal(sense.kind, "sense");
    assert.equal(sense.equippable, true);
    const equipped = await f.call("/api/loadout", {
      modalities: [],
      senses: [String(sense.id)],
    });
    assert.equal(equipped.status, 200, JSON.stringify(equipped.body));
    const beforeExport = await snapshot(f.root);
    const exported = await f.call("/api/faculties/export", {
      name: "shared-ocean-lens",
      keys: [sense.key],
    });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    const shared = exported.body.pack;
    assert.ok(shared && shared.faculties.length === 1);
    assert.equal(shared.faculties[0].name, sense.name);
    assert.equal(shared.faculties[0].function, pack.faculties[0].function);
    assert.equal(shared.faculties[0].category, pack.faculties[0].category);
    assert.deepEqual(
      shared.faculties[0].seed_terms,
      pack.faculties[0].seed_terms,
    );
    assert.equal(shared.pack_sha256, packHash(shared));
    const serialized = JSON.stringify(shared);
    assert.ok(!serialized.includes(privateMarker));
    assert.ok(!serialized.includes("faculty-memory-only-key"));
    assert.ok(!serialized.includes(f.dataDir));
    assert.doesNotMatch(serialized, /rings\.jsonl|groundingContext|active_ops/);
    assert.deepEqual(
      await snapshot(f.root),
      beforeExport,
      "Exporting a pack is read-only.",
    );
    assert.equal((await f.call("/api/verify", {})).body.verified, true);
    const originalBase = state.agent.faculties.find(
      (item) => item.source === "base",
    );
    const baseExport = await f.call("/api/faculties/export", {
      name: "invalid-base-export",
      keys: [originalBase.key],
    });
    assert.ok(
      [400, 422].includes(baseExport.status),
      JSON.stringify(baseExport.body),
    );
    const second = await f.call("/api/agents", {
      name: "Second Receiving Agent",
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const received = await f.call("/api/faculties/import", {
      pack: shared,
      expectedHead: second.body.agent.head.hash,
    });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    const secondState = (await f.call("/api/state")).body.agent;
    assert.equal(secondState.name, "Second Receiving Agent");
    assert.equal(
      secondState.history.length,
      0,
      "Faculty exchange must not import the donor's chat memory.",
    );
    assert.ok(
      secondState.faculties.some(
        (item) => item.name === sense.name && item.equippable,
      ),
    );
    assert.equal((await f.call("/api/verify", {})).body.verified, true);
  },
);

test(
  "review failures cannot be overridden by a pack's own approval claims",
  { timeout: 300000 },
  async (t) => {
    const f = await fixture(t, { review: () => null });
    const before = await snapshot(f.root);
    const result = await f.call("/api/faculties/import", {
      pack: facultyPack(),
      expectedHead: await head(f),
      approved: true,
      scores: Object.fromEntries(DIMENSIONS.map((key) => [key, 255])),
    });
    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.equal(result.body.code, "COVENANT_REJECTED");
    assert.deepEqual(await snapshot(f.root), before);
  },
);
