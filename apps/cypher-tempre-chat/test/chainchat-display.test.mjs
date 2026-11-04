import test from "node:test";
import assert from "node:assert/strict";
import { blockHeight, supportedBridgeVersion, modelCatalogueView, modelSwitchPayload } from "../public/chainchat-display.js";

test("pairing requires the current ChainChat runtime", () => {
  for (const old of [undefined, null, "", "0.3.0", "0.4.0", "0.4.1", "0.4.3", "0.4.999", "0.5.0", "0.5.1", "0.5.999", "0.6.0", "0.6.1", "0.6.999", "0.7.0", "0.7.0-beta", "garbage", "0.07.0", "0.4.9007199254740993"])
    assert.equal(supportedBridgeVersion(old), false);
  assert.equal(supportedBridgeVersion("0.7.1"), false);
  assert.equal(supportedBridgeVersion("0.8.999"), false);
  assert.equal(supportedBridgeVersion("0.9.0"), false);
  assert.equal(supportedBridgeVersion("0.9.1"), false);
  assert.equal(supportedBridgeVersion("0.9.2"), false);
  assert.equal(supportedBridgeVersion("0.9.3"), false);
  assert.equal(supportedBridgeVersion("0.9.4"), false);
  assert.equal(supportedBridgeVersion("0.9.5"), false);
  for (const current of ["0.9.6", "1.0.0"])
    assert.equal(supportedBridgeVersion(current), true);
});
test("current block height is the last sealed index, including genesis zero", () => {
  assert.equal(blockHeight(null), "\u2014");
  assert.equal(blockHeight({ head: { index: 2 } }, false), "\u2014");
  assert.equal(blockHeight({ head: { index: 0 }, ringCount: 1 }), "0");
  const agent = { head: { index: 21 }, ringCount: 22, pending: { bytes: 100000 } };
  assert.equal(blockHeight(agent), "21");
  agent.head.index = 22;
  assert.equal(blockHeight(agent), "22");
  assert.equal(blockHeight({ ringCount: 900 }), "\u2014");
  assert.equal(blockHeight({ head: { index: -1 } }), "\u2014");
  assert.equal(blockHeight({ head: { index: "9007199254740993" } }), BigInt("9007199254740993").toLocaleString());
  assert.equal(blockHeight(null).codePointAt(0), 0x2014);
});

test('model catalogue retains public availability metadata without copying credentials or inventing an active model', () => {
  const source = { apiKey: 'synthetic-private-value', active: { tier: 'free', provider: 'relay', model: 'free-1', key: 'synthetic-private-value' },
    tiers: [{ id: 'free', available: false, notice: 'Temporarily unavailable', models: [
      { id: 'free-1', name: 'Free one', available: true, contextWindow: 32768, maxOutputTokens: 4096, apiKey: 'synthetic-private-value' },
      { id: 'free-1', name: 'Duplicate', available: true }, { id: '', available: true },
    ] }] };
  const view = modelCatalogueView(source), free = view.tiers.find(tier => tier.id === 'free');
  assert.equal(JSON.stringify(view).includes('synthetic-private-value'), false);
  assert.equal(free.models.length, 1); assert.equal(free.models[0].available, false);
  assert.equal(free.models[0].contextWindow, 32768); assert.equal(free.models[0].maxOutputTokens, 4096);
  assert.equal(modelCatalogueView({ active: { tier: 'unknown', model: 'not-active' } }).active, null);
  assert.equal(modelCatalogueView(null).tiers.every(tier => !tier.available && !tier.models.length), true);
});

test('free switching requires advertised availability while BYOK custom IDs reuse only the existing private connection', () => {
  const catalogue = { tiers: [{ id: 'byok', available: true, models: [] }, { id: 'free', available: true,
    models: [{ id: 'free-1', available: true }, { id: 'free-held', available: false }] }] };
  assert.deepEqual(modelSwitchPayload(catalogue, 'byok', ' vendor/custom-model '), { tier: 'byok', model: 'vendor/custom-model' });
  assert.deepEqual(modelSwitchPayload(catalogue, 'byok'), { tier: 'byok' });
  assert.deepEqual(modelSwitchPayload(catalogue, 'free', 'free-1'), { tier: 'free', model: 'free-1' });
  for (const id of ['unadvertised', 'free-held']) assert.throws(() => modelSwitchPayload(catalogue, 'free', id), /not currently available/);
  assert.throws(() => modelSwitchPayload({ tiers: [{ id: 'free', available: false, models: [{ id: 'free-1', available: true }] }] }, 'free', 'free-1'));
  assert.throws(() => modelSwitchPayload(null, 'byok', 'custom'), /Connect your API provider/);
  for (const id of ['', 'bad\nmodel', 'a'.repeat(257)]) assert.throws(() => modelSwitchPayload(catalogue, 'byok', id));
});
