import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash, createPublicKey, verify } from "node:crypto";
import { Wallet, Interface, hashMessage } from "ethers";
import {
  createHoldingsGate,
  HOLDINGS_NETWORK,
  validateHoldingsConfig,
} from "../lib/holdings-gate.mjs";
import { createApp } from "../server.mjs";
import { FRUITS, DIMENSIONS } from "../lib/providers.mjs";

const SITE = "https://cyphertempre.ai",
  OTHER = "https://other.example";
// Public, deterministic fixture keys; these accounts are never used on a live network.
const alice = new Wallet("0x" + "11".repeat(32)),
  bob = new Wallet("0x" + "22".repeat(32));
const amount = BigInt(HOLDINGS_NETWORK.minimumBalance);
const hexWord = (value) => BigInt(value).toString(16).padStart(64, "0");
const PROOF_CHALLENGE = "a1".repeat(32);
const ERC1271 = new Interface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ct-holdings-"));
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(
      absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
        path.basename(absolute).startsWith("ct-holdings-"),
    );
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return root;
}
function rpcFixture() {
  const state = {
    calls: [],
    chain: "0x2105",
    head: "0x64",
    decimals: 18n,
    balance: amount,
    code: "0x",
    magic: "0x1626ba7e" + "0".repeat(56),
    offline: false,
    reorg: false,
    blockReads: 0,
    hook: null,
    balances: new Map(),
    contractCalls: [],
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://mainnet.base.org/");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    if (state.offline)
      throw new Error("Untrusted RPC payload must stay private.");
    const request = JSON.parse(options.body);
    state.calls.push(request);
    if (state.hook) await state.hook(request);
    let result;
    const blockHash = "0x" + "ab".repeat(32),
      reference = { blockHash, requireCanonical: true };
    if (request.method === "eth_chainId") result = state.chain;
    else if (request.method === "eth_blockNumber") result = state.head;
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
      assert.deepEqual(request.params[1], reference);
      result = state.code;
    } else if (request.method === "eth_call") {
      assert.deepEqual(request.params[1], reference);
      const { to, data } = request.params[0];
      if (data.startsWith("0x1626ba7e")) {
        state.contractCalls.push({
          to,
          ...ERC1271.decodeFunctionData("isValidSignature", data).toObject(),
        });
        result = state.magic;
      } else {
        assert.equal(to, HOLDINGS_NETWORK.token);
        if (data === "0x313ce567") result = "0x" + hexWord(state.decimals);
        else {
          assert.match(data, /^0x70a082310{24}[0-9a-f]{40}$/);
          const wallet = "0x" + data.slice(-40);
          result = "0x" + hexWord(state.balances.get(wallet) ?? state.balance);
        }
      }
    } else throw new Error("Unexpected RPC method.");
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    );
  };
  return { state, fetchImpl };
}
async function fixture(t, overrides = {}) {
  const root = await tempRoot(t),
    rpc = rpcFixture();
  let clock = 1_900_000_000_000;
  const gate = await createHoldingsGate({
    root,
    config: { mode: "holdings", required: true },
    fetchImpl: rpc.fetchImpl,
    now: () => clock,
    ...overrides,
  });
  const session = { origin: SITE };
  gate.attach(session);
  const login = async (wallet = alice, target = session, edits = {}) => {
    const challenge = gate.challenge(target, wallet.address);
    const input = {
      requestId: challenge.requestId,
      message: challenge.message,
      signature: await wallet.signMessage(challenge.message),
      ...edits,
    };
    const result = await gate.authenticate(target, input);
    return { challenge, input, result };
  };
  return {
    root,
    gate,
    session,
    rpc,
    login,
    tick: (n) => {
      clock += n;
    },
    now: () => clock,
  };
}

test("configuration requires the exact Base CPHY threshold and explicit test opt-out", () => {
  assert.equal(validateHoldingsConfig({ mode: "holdings" }).required, true);
  assert.equal(
    validateHoldingsConfig({ mode: "holdings", required: false }).required,
    false,
  );
  for (const config of [
    undefined,
    {},
    { mode: "seat" },
    ...[
      { chainId: 1 },
      { token: alice.address },
      { minimumBalance: "1" },
      { decimals: 6 },
      { required: "false" },
      { rpcUrl: "http://mainnet.base.org" },
      { rpcUrl: "https://u:p@mainnet.base.org" },
      { confirmations: 0 },
      { sessionTtlMs: 86400000 },
      { registry: null },
    ].map((change) => ({ mode: "holdings", ...change })),
  ])
    assert.throws(() => validateHoldingsConfig(config), {
      code: "LICENSE_CONFIG_INVALID",
    });
});

test("wallet descriptor makes no RPC calls before proof of control and signs all displayed fields", async (t) => {
  const f = await fixture(t);
  const info = await f.gate.describe(f.session, { challenge: PROOF_CHALLENGE });
  assert.equal(info.status, "wallet-required");
  assert.equal(info.session, null);
  assert.equal(f.rpc.state.calls.length, 0);
  const proof = JSON.parse(info.proof.message);
  assert.equal(proof.purpose, "cypher-tempre-holdings");
  assert.equal(proof.origin, SITE);
  assert.equal(proof.challenge, PROOF_CHALLENGE);
  for (const [field, value] of [
    ["configuration", info.configuration],
    ["verification", info.verification],
    ["session", info.session],
  ])
    assert.equal(
      proof[field + "Sha256"],
      createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    );
  const publicDer = Buffer.from(info.publicKeySPKI, "base64"),
    publicKey = createPublicKey({
      key: publicDer,
      format: "der",
      type: "spki",
    });
  assert.equal(
    info.deviceKey,
    "0x" + createHash("sha256").update(publicDer).digest("hex"),
  );
  assert.equal(
    verify(
      null,
      Buffer.from(info.proof.message),
      publicKey,
      Buffer.from(info.proof.signature, "base64"),
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(info), /privateKey|PKCS8/);
});

test("sign-in challenge binds domain, URI, chain, device and pairing session with distinct deadlines", async (t) => {
  const f = await fixture(t),
    challenge = f.gate.challenge(f.session, alice.address);
  assert.equal(challenge.uri, SITE + "/");
  assert.equal(challenge.chainId, 8453);
  assert.equal(
    challenge.challengeExpiresAt - Date.parse(challenge.issuedAt),
    300000,
  );
  assert.equal(challenge.expiresAt - Date.parse(challenge.issuedAt), 1800000);
  assert.match(challenge.nonce, /^[0-9a-f]{64}$/);
  assert.match(challenge.requestId, /^[0-9a-f]{32}$/);
  for (const fragment of [
    "cyphertempre.ai wants you",
    alice.address,
    "No transaction, token transfer, or approval.",
    "URI: " + SITE + "/",
    "Chain ID: 8453",
    challenge.deviceKey,
    challenge.sessionBinding,
    new Date(challenge.expiresAt).toISOString(),
  ])
    assert.ok(challenge.message.includes(fragment));
  const local = { origin: "http://127.0.0.1:8790" };
  f.gate.attach(local);
  assert.ok(
    f.gate
      .challenge(local, alice.address)
      .message.startsWith("http://127.0.0.1:8790 wants you to sign in"),
  );
  const other = { origin: OTHER };
  f.gate.attach(other);
  assert.notEqual(
    f.gate.challenge(other, alice.address).sessionBinding,
    challenge.sessionBinding,
  );
});

test("entered address and wrong signatures cannot authenticate; altered messages and replay are refused", async (t) => {
  for (const edit of [
    (c) => ({ signature: bob.signMessage(c.message) }),
    (c) => ({ message: c.message.replace("Chain ID: 8453", "Chain ID: 1") }),
    (c) => ({ message: c.message.replace(SITE, OTHER) }),
    (c) => ({
      message: c.message.replace(c.deviceKey, "0x" + "12".repeat(32)),
    }),
  ]) {
    const f = await fixture(t),
      c = f.gate.challenge(f.session, alice.address),
      changed = edit(c);
    if (changed.signature) changed.signature = await changed.signature;
    await assert.rejects(
      f.gate.authenticate(f.session, {
        requestId: c.requestId,
        message: c.message,
        signature: await alice.signMessage(c.message),
        ...changed,
      }),
    );
    assert.equal((await f.gate.describe(f.session)).status, "wallet-required");
    await assert.rejects(
      f.gate.authenticate(f.session, {
        requestId: c.requestId,
        message: c.message,
        signature: await alice.signMessage(c.message),
      }),
      { code: "WALLET_CHALLENGE_USED" },
    );
  }
  const f = await fixture(t),
    a = f.gate.challenge(f.session, alice.address),
    second = { origin: SITE };
  f.gate.attach(second);
  f.gate.challenge(second, alice.address);
  await assert.rejects(
    f.gate.authenticate(second, {
      requestId: a.requestId,
      message: a.message,
      signature: await alice.signMessage(a.message),
    }),
    { code: "WALLET_CHALLENGE_MISMATCH" },
  );
});

test("below, exact and above threshold balances use precise integer amounts", async (t) => {
  for (const balance of [amount - 1n, amount, amount + 1n]) {
    const f = await fixture(t);
    f.rpc.state.balance = balance;
    await f.login();
    const info = await f.gate.describe(f.session);
    assert.equal(info.verification.balance, balance.toString());
    assert.equal(
      info.status,
      balance >= amount ? "active" : "insufficient-balance",
    );
    assert.equal(info.verification.blockNumber, "98");
    assert.equal(info.verification.assurance, "l2-confirmed-not-final");
    if (balance >= amount)
      await f.gate.requireActive(f.session, f.gate.epoch(f.session));
    else
      await assert.rejects(
        f.gate.requireActive(f.session, f.gate.epoch(f.session)),
        { code: "HOLDINGS_REQUIRED" },
      );
  }
});

test("expired challenges are rejected before and after asynchronous verification; grant never outlives signed expiry", async (t) => {
  const f = await fixture(t),
    c = f.gate.challenge(f.session, alice.address),
    signature = await alice.signMessage(c.message);
  f.tick(300001);
  await assert.rejects(
    f.gate.authenticate(f.session, {
      requestId: c.requestId,
      message: c.message,
      signature,
    }),
    { code: "WALLET_CHALLENGE_EXPIRED" },
  );
  const g = await fixture(t),
    c2 = g.gate.challenge(g.session, alice.address);
  g.tick(120000);
  await g.gate.authenticate(g.session, {
    requestId: c2.requestId,
    message: c2.message,
    signature: await alice.signMessage(c2.message),
  });
  assert.equal(
    (await g.gate.describe(g.session)).session.expiresAt,
    c2.expiresAt,
  );
  g.tick(1800000);
  assert.equal((await g.gate.describe(g.session)).status, "session-expired");
  const h = await fixture(t);
  h.rpc.state.hook = async (request) => {
    if (request.method === "eth_getCode") h.tick(300001);
  };
  await assert.rejects(h.login(), { code: "WALLET_CHALLENGE_EXPIRED" });
});

test("live balance cache expires within thirty seconds and forced failures cannot reuse approval", async (t) => {
  const f = await fixture(t);
  await f.login();
  const epoch = f.gate.epoch(f.session),
    count = f.rpc.state.calls.length;
  await f.gate.requireActive(f.session, epoch);
  assert.equal(f.rpc.state.calls.length, count);
  f.rpc.state.balance = amount - 1n;
  f.tick(30001);
  await assert.rejects(f.gate.requireActive(f.session, epoch), {
    code: "HOLDINGS_REQUIRED",
  });
  f.rpc.state.balance = amount;
  assert.equal(
    (await f.gate.describe(f.session, { force: true })).status,
    "active",
  );
  f.rpc.state.offline = true;
  const failed = await f.gate.describe(f.session, { force: true });
  assert.equal(failed.status, "verification-unavailable");
  assert.doesNotMatch(JSON.stringify(failed), /Untrusted RPC payload/);
  await assert.rejects(f.gate.requireActive(f.session, epoch), {
    code: "LICENSE_UNAVAILABLE",
  });
});

test("wrong RPC chain, wrong decimals, reorgs and malformed RPC cannot grant access", async (t) => {
  for (const changes of [{ chain: "0x1" }, { decimals: 6n }, { reorg: true }]) {
    const f = await fixture(t);
    Object.assign(f.rpc.state, changes);
    await assert.rejects(f.login());
    assert.equal((await f.gate.describe(f.session)).status, "wallet-required");
  }
  for (const fetchImpl of [
    async () => new Response("", { status: 302 }),
    async () => new Response("x".repeat(131073)),
    async () => new Response("{}"),
  ]) {
    const f = await fixture(t, { fetchImpl });
    await assert.rejects(f.login(), { code: "LICENSE_RPC_UNAVAILABLE" });
  }
});

test("deployed ERC1271 wallet signatures are checked at the canonical block; invalid and counterfactual signatures fail", async (t) => {
  const f = await fixture(t);
  f.rpc.state.code = "0x60006000f3";
  const c = f.gate.challenge(f.session, bob.address);
  const signature = "0x1234";
  await f.gate.authenticate(f.session, {
    requestId: c.requestId,
    message: c.message,
    signature,
  });
  assert.equal(
    (await f.gate.describe(f.session)).session.walletType,
    "erc1271",
  );
  assert.equal(f.rpc.state.contractCalls[0].hash, hashMessage(c.message));
  assert.equal(f.rpc.state.contractCalls[0].signature, signature);
  f.rpc.state.magic = "0x" + "00".repeat(32);
  assert.equal(
    (await f.gate.describe(f.session, { force: true })).status,
    "verification-unavailable",
  );
  const g = await fixture(t);
  g.rpc.state.code = "0x6000";
  g.rpc.state.magic = "0xffffffff" + "0".repeat(56);
  await assert.rejects(g.login(), {
    code: "WALLET_CONTRACT_SIGNATURE_INVALID",
  });
  const h = await fixture(t),
    pending = h.gate.challenge(h.session, bob.address);
  await assert.rejects(
    h.gate.authenticate(h.session, {
      requestId: pending.requestId,
      message: pending.message,
      signature: "0x" + "6492".repeat(16),
    }),
    { code: "WALLET_COUNTERFACTUAL_UNSUPPORTED" },
  );
  assert.equal(h.rpc.state.calls.length, 0);
});

test("an exact EIP7702 delegation designator accepts the controlling EOA signature only", async (t) => {
  const f = await fixture(t);
  f.rpc.state.code = "0xef0100" + "ab".repeat(20);
  await f.login();
  assert.equal((await f.gate.describe(f.session)).session.walletType, "eoa");
  assert.equal(f.rpc.state.contractCalls.length, 0);
  for (const code of [
    "0xef0101" + "ab".repeat(20),
    "0xef0100" + "ab".repeat(19),
  ]) {
    const g = await fixture(t);
    g.rpc.state.code = code;
    g.rpc.state.magic = "0x" + "00".repeat(32);
    await assert.rejects(g.login(), {
      code: "WALLET_CONTRACT_SIGNATURE_INVALID",
    });
  }
});

test("one-use verification, concurrent logout and newer challenges cannot resurrect authorization", async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    release = deferred();
  f.rpc.state.hook = async (request) => {
    if (request.method === "eth_getCode") {
      entered.resolve();
      await release.promise;
    }
  };
  const c = f.gate.challenge(f.session, alice.address),
    input = {
      requestId: c.requestId,
      message: c.message,
      signature: await alice.signMessage(c.message),
    };
  const first = f.gate.authenticate(f.session, input);
  await entered.promise;
  await assert.rejects(f.gate.authenticate(f.session, input), {
    code: "WALLET_CHALLENGE_USED",
  });
  f.gate.revoke(f.session);
  release.resolve();
  await assert.rejects(first, { code: "WALLET_SESSION_CHANGED" });
  assert.equal((await f.gate.describe(f.session)).status, "wallet-required");
  const g = await fixture(t),
    entered2 = deferred(),
    release2 = deferred();
  g.rpc.state.hook = async (request) => {
    if (request.method === "eth_getCode") {
      entered2.resolve();
      await release2.promise;
    }
  };
  const second = g.login();
  await entered2.promise;
  g.gate.challenge(g.session, bob.address);
  release2.resolve();
  await assert.rejects(second, { code: "WALLET_SESSION_CHANGED" });
});

test("wallet grants are isolated by paired session and no wallet data or signatures are persisted", async (t) => {
  const f = await fixture(t),
    signed = await f.login();
  const other = { origin: SITE };
  f.gate.attach(other);
  const foreign = { origin: OTHER };
  f.gate.attach(foreign);
  for (const session of [other, foreign]) {
    assert.equal((await f.gate.describe(session)).status, "wallet-required");
    await assert.rejects(f.gate.requireActive(session, f.gate.epoch(session)), {
      code: "HOLDINGS_REQUIRED",
    });
  }
  assert.deepEqual(await fs.readdir(f.root), ["bridge-identity.json"]);
  const stored = await fs.readFile(
    path.join(f.root, "bridge-identity.json"),
    "utf8",
  );
  for (const secret of [
    signed.input.signature,
    signed.input.message,
    alice.address,
  ])
    assert.ok(!stored.includes(secret));
  f.gate.revoke(f.session);
  assert.equal((await f.gate.describe(f.session)).session, null);
});

async function httpFixture(t, overrides = {}) {
  const root = await tempRoot(t),
    rpc = rpcFixture();
  let clock = Date.now();
  const calls = [],
    controllers = { generation: null };
  const view = {
    verified: true,
    genesis: { name: "Holdings test", covenant: ["kindness"] },
    head: { index: 0, hash: "ab".repeat(32) },
    faculties: [],
    history: [
      {
        input: "Saved input",
        output: "Saved history",
        index: 1,
        hash: "cd".repeat(32),
      },
    ],
    recentHistory: [],
    context: "Fixture context",
  };
  const app = await createApp({
    dataDir: root,
    pairingCode: "HOLDINGS-TEST",
    publicOrigins: [SITE, OTHER],
    licenseConfig: { mode: "holdings", required: true },
    licenseFetch: rpc.fetchImpl,
    licenseNow: () => clock,
    engine: async (request) => {
      calls.push(request.op);
      if (request.op === "sanitize_source")
        return {
          text: request.text,
          redactionCount: 0,
          bytes: Buffer.byteLength(request.text, "utf8"),
          sourceHash: createHash("sha256").update(request.text).digest("hex"),
        };
      if (overrides.engine) {
        const result = await overrides.engine(request, view);
        if (result !== undefined) return result;
      }
      if (request.op === "evaluate") return { accepted: true, verdict: "SEAL" };
      return view;
    },
    review: async () => ({
      usedRings: [],
      approved: true,
      decision: "approve",
      scores: Object.fromEntries(DIMENSIONS.map((key) => [key, 230])),
      fruits: Object.fromEntries(FRUITS.map((key) => [key, 240])),
      rationale: "Consistent with the fixture covenant.",
    }),
    generate: async (_config, { signal }) => {
      controllers.generation = signal;
      if (overrides.generate) return overrides.generate();
      return { text: "Candidate response." };
    },
    ...overrides.app,
  });
  const record = await app.store.add(
    path.join(root, "agent"),
    "Holdings test",
    true,
  );
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
  const client = (origin = SITE) => {
    let token = "";
    const request = async (endpoint, input, changeHeaders = {}) => {
      const response = await fetch(base + endpoint, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(input === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...changeHeaders,
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      return { status: response.status, body: await response.json() };
    };
    const pair = async () => {
      const result = await request("/api/pair", { code: "HOLDINGS-TEST" });
      token = result.body.token;
      assert.equal(result.status, 200);
    };
    const login = async (wallet = alice) => {
      const started = await request("/api/license/challenge", {
        address: wallet.address,
      });
      assert.equal(started.status, 200);
      return request("/api/license/verify", {
        requestId: started.body.requestId,
        message: started.body.message,
        signature: await wallet.signMessage(started.body.message),
        challenge: PROOF_CHALLENGE,
      });
    };
    return { pair, login, request, token: () => token };
  };
  return {
    app,
    rpc,
    client,
    calls,
    controllers,
    record,
    tick: (n) => {
      clock += n;
    },
  };
}

test("HTTP holdings gate protects mutations while saved history, verification and disconnect remain available", async (t) => {
  const f = await httpFixture(t),
    c = f.client();
  assert.equal((await c.request("/api/license")).status, 401);
  await c.pair();
  assert.equal(
    (
      await c.request("/api/license/check", {
        address: alice.address,
        owner: alice.address,
        challenge: PROOF_CHALLENGE,
      })
    ).body.status,
    "wallet-required",
  );
  for (const endpoint of [
    "/api/agents",
    "/api/provider",
    "/api/chat",
    "/api/continuum",
    "/api/continuum/flush",
    "/api/faculties/import",
    "/api/loadout",
    "/api/settings",
  ])
    assert.equal((await c.request(endpoint, {})).status, 403, endpoint);
  assert.equal(
    (await c.request("/api/state")).body.agent.history[0].output,
    "Saved history",
  );
  assert.equal((await c.request("/api/verify", {})).status, 200);
  assert.equal(
    (await c.request("/api/provider", { disconnect: true })).status,
    200,
  );
  assert.equal(
    (await c.request("/api/license/logout", { challenge: PROOF_CHALLENGE }))
      .body.status,
    "wallet-required",
  );
  const signed = await c.login();
  assert.equal(signed.status, 200);
  assert.equal(signed.body.status, "active");
  assert.equal(
    (await c.request("/api/license", undefined, { Origin: OTHER })).status,
    403,
  );
  const other = f.client();
  await other.pair();
  assert.equal(
    (await other.request("/api/chat", { message: "Cannot borrow access" }))
      .status,
    403,
  );
});

test("long model call cannot release or store output after holdings fail or wallet grant expires", async (t) => {
  for (const reason of ["balance", "rpc", "expiry"]) {
    let f;
    f = await httpFixture(t, {
      generate: () => {
        f.tick(reason === "expiry" ? 1800001 : 30001);
        if (reason === "balance") f.rpc.state.balance = 0n;
        if (reason === "rpc") f.rpc.state.offline = true;
        return { text: "Must remain held." };
      },
    });
    const c = f.client();
    await c.pair();
    await c.login();
    assert.equal(
      (
        await c.request("/api/provider", {
          provider: "openai",
          model: "fixture",
          apiKey: "not-a-real-key",
        })
      ).status,
      200,
    );
    const reply = await c.request("/api/chat", { message: "Test hold" });
    assert.notEqual(reply.status, 200);
    assert.doesNotMatch(JSON.stringify(reply), /Must remain held/);
    assert.equal(f.calls.includes("commit"), false);
    assert.equal((await f.app.store.pending(f.record)).exchanges.length, 0);
  }
});

test("concurrent wallet logout and reauthentication cannot revive an old model request", async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await httpFixture(t, {
    generate: async () => {
      entered.resolve();
      await release.promise;
      return { text: "Obsolete generation." };
    },
  });
  const c = f.client();
  await c.pair();
  await c.login();
  await c.request("/api/provider", {
    provider: "openai",
    model: "fixture",
    apiKey: "not-a-real-key",
  });
  const pending = c.request("/api/chat", { message: "Await logout" });
  await entered.promise;
  assert.equal((await c.request("/api/license/logout", {})).status, 200);
  assert.equal(f.controllers.generation.aborted, true);
  assert.equal((await c.login(bob)).body.status, "active");
  release.resolve();
  const reply = await pending;
  assert.equal(reply.body.code, "WALLET_SESSION_CHANGED");
  assert.doesNotMatch(JSON.stringify(reply), /Obsolete generation/);
  assert.equal(f.calls.includes("commit"), false);
});

test("pairing expiry during an awaited model call is enforced before release", async (t) => {
  let f, c;
  f = await httpFixture(t, {
    generate: () => {
      f.app.sessions.get(c.token()).expires = 0;
      return { text: "Expired pairing candidate." };
    },
  });
  c = f.client();
  await c.pair();
  await c.login();
  await c.request("/api/provider", {
    provider: "openai",
    model: "fixture",
    apiKey: "not-a-real-key",
  });
  const reply = await c.request("/api/chat", { message: "Expire pairing" });
  assert.equal(reply.body.code, "PAIR_REQUIRED");
  assert.equal(f.calls.includes("commit"), false);
});

test("descriptor cannot sign an old wallet balance with a newly authenticated session", async (t) => {
  const f = await fixture(t);
  await f.login();
  f.tick(30001);
  const entered = deferred(),
    release = deferred();
  let first = true;
  f.rpc.state.hook = async (request) => {
    if (first && request.method === "eth_chainId") {
      first = false;
      entered.resolve();
      await release.promise;
    }
  };
  const pending = f.gate.describe(f.session, { force: true });
  await entered.promise;
  f.gate.revoke(f.session);
  await f.login(bob);
  release.resolve();
  const info = await pending;
  assert.equal(info.status, "active");
  assert.equal(info.selectedOwner, bob.address);
  assert.equal(info.session.wallet, bob.address);
  assert.equal(info.verification.wallet, bob.address);
});

test("a chat append authorized before logout keeps its exact receipt and clears pending once", async (t) => {
  const entered = deferred(),
    release = deferred();
  const ring = { index: 2, hash: "ef".repeat(32) };
  const f = await httpFixture(t, {
    engine: async (request, view) => {
      if (request.op !== "commit") return;
      entered.resolve();
      await release.promise;
      view.history.push({
        input: request.input,
        output: request.output,
        ...ring,
      });
      return { accepted: true, ring };
    },
  });
  const c = f.client();
  await c.pair();
  await c.login();
  await c.request("/api/provider", {
    provider: "openai",
    model: "fixture",
    apiKey: "not-a-real-key",
  });
  const pending = c.request("/api/chat", {
    message: "Commit one authorized block",
  });
  await entered.promise;
  assert.equal((await c.request("/api/license/logout", {})).status, 200);
  release.resolve();
  const reply = await pending;
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.message.ring, ring);
  assert.equal(f.calls.filter((op) => op === "commit").length, 1);
  assert.equal((await f.app.store.pending(f.record)).exchanges.length, 0);
  assert.equal(
    (await c.request("/api/state")).body.agent.history.at(-1).output,
    "Candidate response.",
  );
  assert.equal(
    (await c.request("/api/chat", { message: "A new operation stays locked" }))
      .status,
    403,
  );
});

test("continuum expiry during an authorized append reports that committed block before stopping", async (t) => {
  let f;
  const block = { index: 2, hash: "ef".repeat(32), bytes: 4 };
  f = await httpFixture(t, {
    engine: async (request) => {
      if (request.op !== "ingest") return;
      f.tick(1800001);
      return { sealed: true, blocks: [block] };
    },
  });
  const c = f.client();
  await c.pair();
  await c.login();
  await c.request("/api/provider", {
    provider: "openai",
    model: "fixture",
    apiKey: "not-a-real-key",
  });
  const reply = await c.request("/api/continuum", {
    text: "abcdefgh",
    targetBytes: 4,
  });
  assert.equal(reply.status, 403);
  assert.deepEqual(reply.body.gate.committedBlocks, [block]);
  assert.equal(reply.body.gate.consumedBytes, 4);
  assert.equal(f.calls.filter((op) => op === "ingest").length, 1);
});
