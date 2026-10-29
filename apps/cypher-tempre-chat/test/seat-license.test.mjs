import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  createSeatLicense,
  validateSeatConfig,
  SEAT_NETWORK,
  SEAT_SELECTORS,
} from "../lib/seat-license.mjs";
import { createApp } from "../server.mjs";

const site = "https://cyphertempre.ai";
const code = "0x60006000f3";
const codeHash = createHash("sha256")
  .update(Buffer.from(code.slice(2), "hex"))
  .digest("hex");
const config = {
  ...SEAT_NETWORK,
  registry: "0x" + "31".repeat(20),
  runtimeCodeSha256: codeHash,
  required: true,
};
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (value) => value.slice(2).padStart(64, "0");
const owner = "0x" + "21".repeat(20);

async function rootFor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ct-seat-license-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith("ct-seat-license-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

function rpcFixture() {
  const state = {
    calls: [],
    offline: false,
    seatId: 7n,
    generation: 1n,
    token: SEAT_NETWORK.token,
    treasury: SEAT_NETWORK.treasury,
    price: SEAT_NETWORK.unitPrice,
    code,
    chain: "0x2105",
    key: null,
    reorg: false,
    invalidKey: false,
    returnOwner: owner,
    blockReads: 0,
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://mainnet.base.org/");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    if (state.offline) throw new Error("untrusted RPC content must not leak");
    const request = JSON.parse(options.body);
    state.calls.push(request);
    let result;
    const blockHash = "0x" + "ab".repeat(32);
    if (request.method === "eth_chainId") result = state.chain;
    else if (request.method === "eth_blockNumber") result = "0x64";
    else if (request.method === "eth_getBlockByNumber") {
      assert.deepEqual(request.params, ["0x62", false]);
      state.blockReads++;
      result = {
        number: "0x62",
        hash:
          state.reorg && state.blockReads % 2 === 0
            ? "0x" + "cd".repeat(32)
            : blockHash,
      };
    } else if (request.method === "eth_getCode") {
      assert.deepEqual(request.params, [
        config.registry,
        { blockHash, requireCanonical: true },
      ]);
      result = state.code;
    } else if (request.method === "eth_call") {
      assert.deepEqual(request.params[1], {
        blockHash,
        requireCanonical: true,
      });
      assert.equal(request.params[0].to, config.registry);
      const data = request.params[0].data.slice(2),
        selector = data.slice(0, 8);
      if (selector === SEAT_SELECTORS.token)
        result = "0x" + addressWord(state.token);
      else if (selector === SEAT_SELECTORS.treasury)
        result = "0x" + addressWord(state.treasury);
      else if (selector === SEAT_SELECTORS.unitPrice)
        result = "0x" + word(state.price);
      else if (selector === SEAT_SELECTORS.seatOfDevice) {
        assert.equal(data.length, 136);
        state.key = data.slice(72);
        result =
          "0x" +
          word(data.slice(8, 72) === addressWord(owner) ? state.seatId : 0n);
      } else if (selector === SEAT_SELECTORS.seats) {
        assert.equal(data.slice(8), word(state.seatId));
        result =
          "0x" +
          addressWord(state.returnOwner) +
          word(state.generation) +
          (state.invalidKey ? "00".repeat(32) : state.key);
      } else throw new Error("Unexpected selector.");
    } else throw new Error("Unexpected RPC method.");
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      { status: 200 },
    );
  };
  return { state, fetchImpl };
}

async function ownedLicense(options) {
  const service = await createSeatLicense(options);
  await service.selectOwner(owner);
  return service;
}

test("bridge identity persists, proves possession, and never exposes its private key", async (t) => {
  const root = await rootFor(t);
  const noRpc = () => {
    throw new Error("Payments-disabled state must not use the network.");
  };
  const a = await createSeatLicense({
    root,
    config: { registry: null },
    fetchImpl: noRpc,
  });
  const first = await a.describe({ origin: site });
  const second = await (
    await createSeatLicense({ root, config: {} })
  ).describe({ origin: site });
  assert.equal(first.status, "payments-not-open");
  assert.equal(first.paymentsOpen, false);
  assert.equal(first.deviceKey, second.deviceKey);
  assert.equal(first.publicKeySPKI, second.publicKeySPKI);
  assert.notEqual(first.proof.message, second.proof.message);
  const publicDer = Buffer.from(first.publicKeySPKI, "base64");
  assert.equal(
    first.deviceKey,
    "0x" + createHash("sha256").update(publicDer).digest("hex"),
  );
  assert.equal(JSON.parse(first.proof.message).origin, site);
  assert.equal(
    verify(
      null,
      Buffer.from(first.proof.message),
      createPublicKey({ key: publicDer, format: "der", type: "spki" }),
      Buffer.from(first.proof.signature, "base64"),
    ),
    true,
  );
  const stored = JSON.parse(
    await fs.readFile(path.join(root, "bridge-identity.json"), "utf8"),
  );
  assert.ok(stored.privateKeyPKCS8);
  assert.ok(!JSON.stringify(first).includes(stored.privateKeyPKCS8));
  assert.ok(!JSON.stringify(first).includes(root));
  if (process.platform !== "win32")
    assert.equal(
      (await fs.stat(path.join(root, "bridge-identity.json"))).mode & 0o777,
      0o600,
    );
});

test("racing initializers share one complete bridge identity", async (t) => {
  const root = await rootFor(t);
  const services = await Promise.all(
    Array.from({ length: 4 }, () => createSeatLicense({ root })),
  );
  const descriptions = await Promise.all(
    services.map((service) => service.describe({ origin: site })),
  );
  assert.equal(
    new Set(descriptions.map((description) => description.deviceKey)).size,
    1,
  );
});

test("malformed saved identities are held without replacement", async (t) => {
  const root = await rootFor(t),
    file = path.join(root, "bridge-identity.json");
  await fs.writeFile(file, '{"invalid":true}');
  await assert.rejects(createSeatLicense({ root }), {
    code: "BRIDGE_IDENTITY_INVALID",
  });
  assert.equal(await fs.readFile(file, "utf8"), '{"invalid":true}');
});

test("required unpaid state rejects operations even while payment deployment is pending", async (t) => {
  const service = await createSeatLicense({
    root: await rootFor(t),
    config: { required: true },
  });
  assert.equal((await service.describe()).status, "payments-not-open");
  await assert.rejects(service.requireActive(), {
    code: "LICENSE_REQUIRED",
    status: 402,
  });
});

test("invalid enabling configuration cannot disable or misdirect the license gate", () => {
  for (const change of [
    { required: "false" },
    { chainId: 1 },
    { token: owner },
    { treasury: owner },
    { unitPrice: "1" },
    { registry: config.registry },
    { registry: owner, runtimeCodeSha256: "bad" },
    { rpcUrl: "http://mainnet.base.org" },
    { rpcUrl: "https://user:password@mainnet.base.org" },
    { rpcUrl: "https://mainnet.base.org/#fragment" },
    { confirmations: 0 },
  ])
    assert.throws(() => validateSeatConfig(change), {
      code: "LICENSE_CONFIG_INVALID",
    });
});

test("confirmed license requires exact code, contract parameters and device binding at one block", async (t) => {
  const fixture = rpcFixture();
  const service = await ownedLicense({
    root: await rootFor(t),
    config,
    fetchImpl: fixture.fetchImpl,
  });
  const info = await service.describe({ origin: site });
  assert.equal(info.status, "active");
  assert.equal(info.verification.seatId, "7");
  assert.equal(info.verification.generation, "1");
  assert.equal(info.verification.owner, owner);
  assert.equal(info.verification.blockNumber, "98");
  assert.equal(info.verification.assurance, "l2-confirmed-not-final");
  assert.equal(
    info.verification.expiresAt - info.verification.checkedAt,
    30000,
  );
  assert.equal(info.configuration.runtimeCodeSha256, codeHash);
  assert.ok(!JSON.stringify(fixture.state.calls).includes("privateKey"));
  await service.requireActive();
  assert.equal(fixture.state.blockReads, 2);
});

test("unbound or rotated-out device cannot claim another seat", async (t) => {
  for (const change of [
    { seatId: 0n },
    { invalidKey: true },
    { generation: 0n },
    { generation: 1n << 64n },
  ]) {
    const fixture = rpcFixture();
    Object.assign(fixture.state, change);
    const service = await ownedLicense({
      root: await rootFor(t),
      config,
      fetchImpl: fixture.fetchImpl,
    });
    assert.notEqual((await service.describe()).status, "active");
    await assert.rejects(service.requireActive());
  }
});

test("wrong network, code, token, treasury, price or changed block all fail closed", async (t) => {
  for (const change of [
    { chain: "0x1" },
    { code: "0x6001" },
    { token: owner },
    { treasury: owner },
    { price: "1" },
    { reorg: true },
  ]) {
    const fixture = rpcFixture();
    Object.assign(fixture.state, change);
    const service = await ownedLicense({
      root: await rootFor(t),
      config,
      fetchImpl: fixture.fetchImpl,
    });
    const result = await service.describe();
    assert.equal(result.status, "verification-unavailable");
    await assert.rejects(service.requireActive(), {
      code: "LICENSE_UNAVAILABLE",
    });
  }
});

test("expired or explicitly rechecked approvals are not reused after RPC failure", async (t) => {
  let clock = 100000;
  const fixture = rpcFixture();
  const service = await ownedLicense({
    root: await rootFor(t),
    config,
    fetchImpl: fixture.fetchImpl,
    now: () => clock,
  });
  assert.equal((await service.describe()).status, "active");
  fixture.state.offline = true;
  clock += 30001;
  await assert.rejects(service.requireActive(), {
    code: "LICENSE_UNAVAILABLE",
  });
  fixture.state.offline = false;
  assert.equal((await service.describe({ force: true })).status, "active");
  fixture.state.offline = true;
  const recheck = await service.describe({ force: true });
  assert.equal(recheck.status, "verification-unavailable");
  assert.doesNotMatch(JSON.stringify(recheck), /untrusted RPC content/);
  await assert.rejects(service.requireActive(), {
    code: "LICENSE_UNAVAILABLE",
  });
});

test("RPC HTTP errors, redirects, oversized or malformed responses never approve", async (t) => {
  for (const fetchImpl of [
    async () =>
      new Response("", {
        status: 302,
        headers: { Location: "https://evil.example" },
      }),
    async () => new Response("x".repeat(131073)),
    async () => new Response("{}"),
    async () =>
      new Response('{"jsonrpc":"2.0","id":"wrong","result":"0x2105"}'),
  ]) {
    const service = await ownedLicense({
      root: await rootFor(t),
      config,
      fetchImpl,
    });
    assert.equal((await service.describe()).status, "verification-unavailable");
  }
});

async function httpFixture(t, options = {}) {
  const dataDir = await rootFor(t);
  const app = await createApp({
    dataDir,
    pairingCode: "LICENSE-TEST",
    publicOrigins: [site],
    ...options,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(
    () =>
      new Promise((resolve) => {
        app.server.closeAllConnections();
        app.server.close(resolve);
      }),
  );
  let token = "";
  const request = async (endpoint, input) => {
    const response = await fetch(base + endpoint, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Origin: site,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(input === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  const pair = async () => {
    const result = await request("/api/pair", { code: "LICENSE-TEST" });
    token = result.body.token;
    assert.equal(result.status, 200);
  };
  return { app, request, pair, dataDir };
}

test("license routes require pairing and hold paid mutations while preserving local inspection/disconnect", async (t) => {
  const fixture = rpcFixture();
  fixture.state.seatId = 0n;
  const f = await httpFixture(t, {
    licenseConfig: config,
    licenseFetch: fixture.fetchImpl,
  });
  assert.equal((await f.request("/api/license")).status, 401);
  await f.pair();
  assert.equal((await f.request("/api/license")).body.status, "choose-owner");
  assert.equal(
    (
      await f.request("/api/license/check", {
        owner,
        challenge: "12".repeat(32),
      })
    ).body.status,
    "unlicensed",
  );
  assert.equal((await f.request("/api/license")).body.selectedOwner, owner);
  for (const endpoint of [
    "/api/agents",
    "/api/provider",
    "/api/chat",
    "/api/continuum",
    "/api/continuum/flush",
    "/api/faculties/import",
  ])
    assert.equal((await f.request(endpoint, {})).status, 402, endpoint);
  assert.equal((await f.request("/api/state")).status, 200);
  assert.equal(
    (await f.request("/api/provider", { disconnect: true })).status,
    200,
  );
  assert.equal((await f.request("/api/unpair", {})).status, 200);
});

test("license expiry during model generation holds output before pending storage or commitment", async (t) => {
  let clock = 100000;
  const fixture = rpcFixture(),
    calls = [];
  const view = {
    verified: true,
    genesis: { name: "License test", covenant: ["kindness"] },
    head: { index: 0, hash: "ab".repeat(32) },
    faculties: [],
    history: [],
    recentHistory: [],
    context: "Local fixture",
  };
  const f = await httpFixture(t, {
    licenseConfig: config,
    licenseFetch: fixture.fetchImpl,
    licenseNow: () => clock,
    engine: async (request) => {
      calls.push(request.op);
      return view;
    },
    generate: async () => {
      clock += 30001;
      fixture.state.offline = true;
      return { text: "Held license test candidate." };
    },
  });
  const record = await f.app.store.add(
    path.join(f.dataDir, "agent"),
    "License test",
    true,
  );
  await f.pair();
  assert.equal(
    (await f.request("/api/license/check", { owner })).body.status,
    "active",
  );
  assert.equal(
    (
      await f.request("/api/provider", {
        provider: "openai",
        model: "test-model",
        apiKey: "not-a-live-api-key",
      })
    ).status,
    200,
  );
  const response = await f.request("/api/chat", { message: "Test expiry." });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "LICENSE_UNAVAILABLE");
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /Held license test candidate/,
  );
  assert.equal(calls.includes("commit"), false);
  assert.equal((await f.app.store.pending(record)).exchanges.length, 0);
});

test("owner selection persists and an unrelated purchaser cannot supply a seat for it", async (t) => {
  const root = await rootFor(t),
    fixture = rpcFixture();
  const service = await createSeatLicense({
    root,
    config,
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal((await service.describe()).status, "choose-owner");
  assert.equal(fixture.state.calls.length, 0);
  await assert.rejects(service.selectOwner("invalid"), {
    code: "LICENSE_OWNER_INVALID",
  });
  await service.selectOwner(owner);
  assert.equal((await service.describe()).status, "active");
  const restored = await createSeatLicense({
    root,
    config,
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal((await restored.describe()).selectedOwner, owner);
  await restored.selectOwner("0x" + "41".repeat(20));
  assert.equal((await restored.describe()).status, "unlicensed");
  await service.selectOwner(owner);
  fixture.state.returnOwner = "0x" + "41".repeat(20);
  assert.equal(
    (await service.describe({ force: true })).status,
    "verification-unavailable",
  );
});

test("proof signs the browser challenge, paired origin, status and configuration", async (t) => {
  const service = await createSeatLicense({ root: await rootFor(t) });
  const challenge = "12".repeat(32);
  const info = await service.describe({ origin: site, challenge });
  const message = JSON.parse(info.proof.message);
  assert.equal(info.proof.challenge, challenge);
  assert.equal(message.challenge, challenge);
  assert.equal(message.purpose, "cypher-tempre-instance");
  assert.equal(message.origin, site);
  assert.equal(message.status, info.status);
  assert.equal(
    message.configurationSha256,
    createHash("sha256")
      .update(JSON.stringify(info.configuration))
      .digest("hex"),
  );
  const key = createPublicKey({
    key: Buffer.from(info.publicKeySPKI, "base64"),
    format: "der",
    type: "spki",
  });
  assert.equal(
    verify(
      null,
      Buffer.from(info.proof.message),
      key,
      Buffer.from(info.proof.signature, "base64"),
    ),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(info.proof.message.replace(challenge, "34".repeat(32))),
      key,
      Buffer.from(info.proof.signature, "base64"),
    ),
    false,
  );
  await assert.rejects(service.describe({ origin: site, challenge: "short" }), {
    code: "LICENSE_CHALLENGE_INVALID",
  });
});
