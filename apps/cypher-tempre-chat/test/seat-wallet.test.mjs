import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  CPHY_TOKEN,
  CPHY_TREASURY,
  CPHY_PRICE,
  uintWord,
  encodeDevicePurchase,
  validateDeployment,
  purchaseBoundSeats,
  verifyBridgeIdentity,
  matchingConfiguration,
} from "../public/seat-wallet.js";

const keyA = "0x" + "11".repeat(32),
  keyB = "0x" + "22".repeat(32);
const registry = "0x" + "33".repeat(20),
  buyer = "0x" + "44".repeat(20);
const methods = {
  "purchaseAndBind(bytes32[])": "a62919de",
  "token()": "fc0c546a",
  "treasury()": "61d027b3",
  "UNIT_PRICE()": "afa40bbd",
};
const code = "0x60006000";
const config = {
  required: true,
  chainId: 8453,
  token: CPHY_TOKEN,
  treasury: CPHY_TREASURY,
  unitPrice: CPHY_PRICE.toString(),
  registry,
  runtimeCodeSha256: createHash("sha256")
    .update(Buffer.from(code.slice(2), "hex"))
    .digest("hex"),
};

function walletFixture({
  accountChanges = false,
  codeOverride = code,
  allowance = 0n,
} = {}) {
  const requests = [];
  let accountReads = 0;
  return {
    requests,
    request: async (req) => {
      requests.push(req);
      if (req.method === "eth_chainId") return "0x2105";
      if (req.method === "eth_accounts")
        return [
          accountChanges && accountReads > 1 ? "0x" + "55".repeat(20) : buyer,
        ];
      if (req.method === "eth_getCode") return codeOverride;
      if (req.method === "eth_requestAccounts")
        return [
          accountChanges && ++accountReads > 1 ? "0x" + "55".repeat(20) : buyer,
        ];
      if (req.method === "eth_getTransactionReceipt") return { status: "0x1" };
      if (req.method === "eth_sendTransaction") return "0x" + "66".repeat(32);
      if (req.method === "eth_call") {
        const selector = req.params[0].data.slice(2, 10);
        if (selector === methods["token()"])
          return "0x" + CPHY_TOKEN.slice(2).padStart(64, "0");
        if (selector === methods["treasury()"])
          return "0x" + CPHY_TREASURY.slice(2).padStart(64, "0");
        if (selector === methods["UNIT_PRICE()"])
          return "0x" + uintWord(CPHY_PRICE);
        if (selector === "dd62ed3e") return "0x" + uintWord(allowance);
        if (selector === "d94a2e60") return "0x" + uintWord(0);
      }
      throw Error("Unexpected request " + req.method);
    },
  };
}
test("device array encoding bounds and uniqueness prevent invalid payments", () => {
  assert.equal(
    encodeDevicePurchase("a62919de", [keyA, keyB]),
    "0xa62919de" + uintWord(32) + uintWord(2) + keyA.slice(2) + keyB.slice(2),
  );
  for (const keys of [
    [],
    [keyA, keyA.toUpperCase()],
    [null],
    ["0x" + "00".repeat(32)],
    Array(65).fill(keyA),
  ])
    assert.throws(() => encodeDevicePurchase("a62919de", keys));
  assert.throws(() => uintWord(-1));
  assert.throws(() => uintWord(2n ** 256n));
  assert.throws(() => encodeDevicePurchase("efef39a1", [keyA]));
});
test("undeployed or mismatched configuration cannot request wallet access", async () => {
  for (const modified of [
    { ...config, required: false },
    { ...config, registry: null },
    { ...config, runtimeCodeSha256: null },
    { ...config, treasury: buyer },
    { ...config, token: buyer },
    { ...config, chainId: 1 },
    { ...config, unitPrice: "1" },
  ]) {
    assert.throws(() => validateDeployment(modified));
    const wallet = walletFixture();
    await assert.rejects(
      purchaseBoundSeats({
        config: modified,
        methods,
        wallet,
        keys: [keyA],
        report: () => {},
      }),
    );
    assert.equal(wallet.requests.length, 0);
  }
});
test("two seats approve exact42000CPHY and purchase registry, never directsend", async () => {
  const wallet = walletFixture();
  await purchaseBoundSeats({
    config,
    methods,
    wallet,
    keys: [keyA, keyB],
    report: () => {},
  });
  const sent = wallet.requests
    .filter((r) => r.method === "eth_sendTransaction")
    .map((r) => r.params[0]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, CPHY_TOKEN);
  assert.equal(
    sent[0].data,
    "0x095ea7b3" +
      registry.slice(2).padStart(64, "0") +
      uintWord(CPHY_PRICE * 2n),
  );
  assert.equal(sent[1].to, registry);
  assert.equal(
    sent[1].data,
    encodeDevicePurchase(methods["purchaseAndBind(bytes32[])"], [keyA, keyB]),
  );
  assert.equal(sent[1].value, "0x0");
  assert.ok(sent.every((tx) => tx.chainId === "0x2105"));
});
test("changed code fails before account access or allowance", async () => {
  const wallet = walletFixture({ codeOverride: "0x01" });
  await assert.rejects(
    purchaseBoundSeats({
      config,
      methods,
      wallet,
      keys: [keyA],
      report: () => {},
    }),
    /reviewed release/,
  );
  assert.equal(
    wallet.requests.some(
      (r) =>
        r.method === "eth_requestAccounts" ||
        r.method === "eth_sendTransaction",
    ),
    false,
  );
});
test("account changed after approval cannot purchase with another account", async () => {
  const wallet = walletFixture({ accountChanges: true });
  await assert.rejects(
    purchaseBoundSeats({
      config,
      methods,
      wallet,
      keys: [keyA],
      report: () => {},
    }),
    /account changed/,
  );
  assert.equal(
    wallet.requests.filter((r) => r.method === "eth_sendTransaction").length,
    1,
  );
});
test("sufficient allowance does not request another approval", async () => {
  const wallet = walletFixture({ allowance: CPHY_PRICE });
  await purchaseBoundSeats({
    config,
    methods,
    wallet,
    keys: [keyA],
    report: () => {},
  });
  const sent = wallet.requests.filter(
    (r) => r.method === "eth_sendTransaction",
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params[0].to, registry);
});
test("browser verifies fresh bridge possession and rejects replay, changed fields and configuration", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const challenge = "77".repeat(32),
    origin = "https://cyphertempre.ai";
  const info = {
    deviceKey: "0x" + hash(spki),
    publicKeySPKI: spki.toString("base64"),
    selectedOwner: buyer,
    status: "active",
    configuration: config,
  };
  const message = JSON.stringify({
    purpose: "cypher-tempre-instance",
    origin,
    challenge,
    issuedAt: Date.now(),
    deviceKey: info.deviceKey,
    selectedOwner: buyer,
    status: "active",
    configurationSha256: hash(JSON.stringify(config)),
  });
  info.proof = {
    algorithm: "Ed25519",
    challenge,
    message,
    signature: sign(null, Buffer.from(message), privateKey).toString("base64"),
  };
  assert.equal(await verifyBridgeIdentity(info, challenge, origin), true);
  await assert.rejects(verifyBridgeIdentity(info, "88".repeat(32), origin));
  await assert.rejects(
    verifyBridgeIdentity(info, challenge, "https://other.example"),
  );
  for (const altered of [
    { ...info, deviceKey: keyA },
    { ...info, status: "unlicensed" },
    { ...info, selectedOwner: registry },
    { ...info, configuration: { ...config, required: false } },
  ])
    await assert.rejects(verifyBridgeIdentity(altered, challenge, origin));
  assert.equal(matchingConfiguration(config, { ...config }), true);
  for (const field of [
    "registry",
    "runtimeCodeSha256",
    "chainId",
    "token",
    "treasury",
    "unitPrice",
    "required",
    "confirmations",
  ])
    assert.equal(
      matchingConfiguration(config, { ...config, [field]: "wrong" }),
      false,
    );
});
test("changed purchase selector cannot use a larger standing allowance", async () => {
  const wallet = walletFixture({ allowance: CPHY_PRICE * 64n });
  await assert.rejects(
    purchaseBoundSeats({
      config,
      methods: { ...methods, "purchaseAndBind(bytes32[])": "efef39a1" },
      wallet,
      keys: [keyA],
      report: () => {},
    }),
    /interface/,
  );
  assert.equal(wallet.requests.length, 0);
});
