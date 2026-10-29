import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, ZeroAddress, ZeroHash, id } from 'ethers';
import { compile, root, runtimeBytecode } from '../scripts/compiler.mjs';

const compilation = compile({ 'test/MockTokens.sol': { content: fs.readFileSync(path.join(root, 'test/MockTokens.sol'), 'utf8') } });
const registryArtifact = compilation.contracts['src/CypherTempreSeats.sol'].CypherTempreSeats;
const tokenArtifact = compilation.contracts['test/MockTokens.sol'].MockToken;
const PRICE = 21_000n * 10n ** 18n;
let transport, provider, buyer, outsider, treasury, buyerAddress, treasuryAddress;

before(async () => {
  transport = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai', chainId: 8453 }, wallet: { totalAccounts: 4 }, miner: { blockGasLimit: 30_000_000 } });
  provider = new BrowserProvider(transport, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  buyer = await provider.getSigner(0);
  outsider = await provider.getSigner(1);
  treasury = await provider.getSigner(2);
  buyerAddress = await buyer.getAddress();
  treasuryAddress = await treasury.getAddress();
});
after(async () => { await provider?.destroy(); await transport?.disconnect(); });

async function deploy(artifact, args = []) {
  const contract = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, buyer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}
async function mined(promise) { return (await promise).wait(); }
async function setup() {
  const token = await deploy(tokenArtifact, [18]);
  const registry = await deploy(registryArtifact, [await token.getAddress(), treasuryAddress]);
  await mined(token.mint(buyerAddress, PRICE * 200n));
  await mined(token.approve(await registry.getAddress(), PRICE * 200n));
  return { token, registry };
}
async function rejects(promise) { await assert.rejects(async () => { const tx = await promise; if (tx?.wait) await tx.wait(); }); }

test('deployment pins immutable settings and predicted runtime matches actual bytecode', async () => {
  const { token, registry } = await setup();
  assert.equal(await registry.token(), await token.getAddress());
  assert.equal(await registry.treasury(), treasuryAddress);
  assert.equal(await registry.UNIT_PRICE(), PRICE);
  assert.equal(await registry.MAX_BATCH(), 64n);
  assert.equal(await provider.getCode(await registry.getAddress()), runtimeBytecode(compilation, await token.getAddress(), treasuryAddress));
});

test('constructor rejects zero/non-contract/wrong-decimal tokens and invalid treasury', async () => {
  const token = await deploy(tokenArtifact, [18]);
  const wrongDecimals = await deploy(tokenArtifact, [6]);
  await rejects(deploy(registryArtifact, [ZeroAddress, treasuryAddress]));
  await rejects(deploy(registryArtifact, [buyerAddress, treasuryAddress]));
  await rejects(deploy(registryArtifact, [await wrongDecimals.getAddress(), treasuryAddress]));
  await rejects(deploy(registryArtifact, [await token.getAddress(), ZeroAddress]));
  await rejects(deploy(registryArtifact, [await token.getAddress(), await token.getAddress()]));
});

test('batch purchase pays exact amount, assigns sequential owner seats and binds unique keys', async () => {
  const { token, registry } = await setup();
  const keys = [id('first device'), id('second device'), id('third device')];
  assert.equal(await registry.purchaseAndBind.staticCall(keys), 1n);
  await mined(registry.purchaseAndBind(keys));
  assert.equal(await registry.totalSeats(), 3n);
  assert.equal(await token.balanceOf(treasuryAddress), PRICE * 3n);
  assert.equal(await token.balanceOf(await registry.getAddress()), 0n);
  for (let i = 0; i < keys.length; ++i) {
    const seat = await registry.seats(i + 1);
    assert.equal(seat.owner, buyerAddress);
    assert.equal(seat.generation, 1n);
    assert.equal(seat.deviceKey, keys[i]);
    assert.equal(await registry.seatOfDevice(buyerAddress, keys[i]), BigInt(i + 1));
  }
});

test('unbound purchase reserves ownership and only owner can bind', async () => {
  const { registry } = await setup();
  await mined(registry.purchase(2));
  assert.equal((await registry.seats(1)).generation, 0n);
  assert.equal((await registry.seats(1)).deviceKey, ZeroHash);
  await rejects(registry.connect(outsider).bind(1, id('stolen')));
  await rejects(registry.bind(999, id('nonexistent')));
  await rejects(registry.bind(0, id('zero seat')));
  await mined(registry.bind(1, id('bound')));
  assert.equal((await registry.seats(1)).generation, 1n);
  await rejects(registry.bind(1, id('rebind')));
  await rejects(registry.rotate(2, id('unbound rotation')));
});

test('rotation revokes previous key, increases generation, and rejects unauthorized/no-op/duplicate replacements', async () => {
  const { registry } = await setup();
  const oldKey = id('old'), newKey = id('new'), occupied = id('occupied');
  await mined(registry.purchaseAndBind([oldKey, occupied]));
  await rejects(registry.connect(outsider).rotate(1, newKey));
  await rejects(registry.rotate(1, oldKey));
  await rejects(registry.rotate(1, occupied));
  await rejects(registry.rotate(1, ZeroHash));
  await mined(registry.rotate(1, newKey));
  assert.equal(await registry.seatOfDevice(buyerAddress, oldKey), 0n);
  assert.equal(await registry.seatOfDevice(buyerAddress, newKey), 1n);
  assert.equal((await registry.seats(1)).generation, 2n);
  await mined(registry.rotate(1, id('third key')));
  assert.equal((await registry.seats(1)).generation, 3n);
  assert.equal(await registry.seatOfDevice(buyerAddress, newKey), 0n);
});

test('duplicate or zero keys roll the entire batch back without charging', async () => {
  const { token, registry } = await setup();
  const key = id('same');
  await rejects(registry.purchaseAndBind([key, key], { gasLimit: 1_000_000 }));
  await rejects(registry.purchaseAndBind([key, ZeroHash], { gasLimit: 1_000_000 }));
  assert.equal(await registry.totalSeats(), 0n);
  assert.equal(await registry.seatOfDevice(buyerAddress, key), 0n);
  assert.equal(await token.balanceOf(treasuryAddress), 0n);
  assert.equal(await token.balanceOf(buyerAddress), PRICE * 200n);
  await mined(registry.purchaseAndBind([key]));
  await rejects(registry.purchaseAndBind([id('fresh'), key], { gasLimit: 1_000_000 }));
  assert.equal(await registry.totalSeats(), 1n);
  assert.equal(await registry.seatOfDevice(buyerAddress, id('fresh')), 0n);
  assert.equal(await token.balanceOf(treasuryAddress), PRICE);
});

test('a public key squatter cannot block another owner or control their purchased seat', async () => {
  const { token, registry } = await setup();
  const key = id('observed pending honest purchase');
  const outsiderAddress = await outsider.getAddress();
  await mined(token.mint(outsiderAddress, PRICE * 2n));
  await mined(token.connect(outsider).approve(await registry.getAddress(), PRICE * 2n));
  await mined(registry.connect(outsider).purchase(1));
  // Attacker binds a visible commitment before the honest purchase is mined.
  await mined(registry.connect(outsider).bind(1, key));
  await mined(registry.purchaseAndBind([key]));
  assert.equal(await registry.seatOfDevice(outsiderAddress, key), 1n);
  assert.equal(await registry.seatOfDevice(buyerAddress, key), 2n);
  assert.equal((await registry.seats(2)).owner, buyerAddress);
  await rejects(registry.connect(outsider).rotate(2, id('stolen rotation')));
  await mined(registry.purchase(1));
  await rejects(registry.bind(3, key));
  await rejects(registry.purchaseAndBind([key]));
  await mined(registry.rotate(2, id('honest replacement')));
  assert.equal(await registry.seatOfDevice(buyerAddress, key), 0n);
  assert.equal(await registry.seatOfDevice(outsiderAddress, key), 1n);
});

test('quantities reject zero/over-limit and maximum batch remains usable', async () => {
  const { registry, token } = await setup();
  await rejects(registry.purchase(0));
  await rejects(registry.purchase(65));
  await rejects(registry.purchaseAndBind([]));
  await rejects(registry.purchaseAndBind(Array.from({ length: 65 }, (_, i) => id(`oversize ${i}`))));
  await mined(registry.purchaseAndBind(Array.from({ length: 64 }, (_, i) => id(`max ${i}`))));
  assert.equal(await registry.totalSeats(), 64n);
  assert.equal(await token.balanceOf(treasuryAddress), PRICE * 64n);
});

test('under-receipt reverts seat, payment and allowance changes atomically', async () => {
  const { token, registry } = await setup();
  await mined(token.configure(1, ZeroAddress));
  const beforeAllowance = await token.allowance(buyerAddress, await registry.getAddress());
  await rejects(registry.purchaseAndBind([id('fee device')], { gasLimit: 1_000_000 }));
  assert.equal(await registry.totalSeats(), 0n);
  assert.equal(await token.balanceOf(treasuryAddress), 0n);
  assert.equal(await token.balanceOf(buyerAddress), PRICE * 200n);
  assert.equal(await token.allowance(buyerAddress, await registry.getAddress()), beforeAllowance);
});

test('SafeERC20 rejects false-return tokens and supports no-return tokens', async () => {
  const { token, registry } = await setup();
  await mined(token.configure(2, ZeroAddress));
  await rejects(registry.purchase(1, { gasLimit: 1_000_000 }));
  assert.equal(await registry.totalSeats(), 0n);
  await mined(token.configure(4, ZeroAddress));
  await mined(registry.purchase(1));
  assert.equal(await registry.totalSeats(), 1n);
  assert.equal(await token.balanceOf(treasuryAddress), PRICE);
});

test('malicious token callback cannot reenter purchasing', async () => {
  const { token, registry } = await setup();
  await mined(token.configure(3, await registry.getAddress()));
  await mined(registry.purchaseAndBind([id('reentry test')]));
  assert.equal(await token.reentryBlocked(), true);
  assert.equal(await token.callbackError(), id('ReentrancyGuardReentrantCall()').slice(0, 10));
  assert.equal(await registry.totalSeats(), 1n);
  assert.equal(await token.balanceOf(treasuryAddress), PRICE);
});

test('insufficient allowance or balance never leaves an unpaid seat', async () => {
  const { token, registry } = await setup();
  await mined(token.approve(await registry.getAddress(), PRICE - 1n));
  await rejects(registry.purchase(1, { gasLimit: 1_000_000 }));
  await mined(token.connect(outsider).approve(await registry.getAddress(), PRICE));
  await rejects(registry.connect(outsider).purchase(1, { gasLimit: 1_000_000 }));
  assert.equal(await registry.totalSeats(), 0n);
  assert.equal(await token.balanceOf(treasuryAddress), 0n);
});

test('direct token transfers do not create seats and native ETH is rejected', async () => {
  const { token, registry } = await setup();
  await mined(token.approve(buyerAddress, PRICE));
  await mined(token.transferFrom(buyerAddress, treasuryAddress, PRICE));
  assert.equal(await registry.totalSeats(), 0n);
  await rejects(buyer.sendTransaction({ to: await registry.getAddress(), value: 1n }));
});
