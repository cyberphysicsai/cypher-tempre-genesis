import test from "node:test";
import assert from "node:assert/strict";
import { blockHeight, supportedBridgeVersion } from "../public/chainchat-display.js";

test("pairing requires the current ChainChat runtime", () => {
  for (const old of [undefined, null, "", "0.3.0", "0.4.0", "0.4.1", "0.4.3", "0.4.999", "0.5.0", "0.5.1", "0.5.999", "0.6.0", "0.6.1", "0.6.999", "0.7.0", "0.7.0-beta", "garbage", "0.07.0", "0.4.9007199254740993"])
    assert.equal(supportedBridgeVersion(old), false);
  assert.equal(supportedBridgeVersion("0.7.1"), false);
  assert.equal(supportedBridgeVersion("0.8.999"), false);
  assert.equal(supportedBridgeVersion("0.9.0"), false);
  assert.equal(supportedBridgeVersion("0.9.1"), false);
  assert.equal(supportedBridgeVersion("0.9.2"), false);
  for (const current of ["0.9.3", "1.0.0"])
    assert.equal(supportedBridgeVersion(current), true);
});
test("current block height is the last sealed index, including genesis zero", () => {
  assert.equal(blockHeight(null), "â€”");
  assert.equal(blockHeight({ head: { index: 2 } }, false), "â€”");
  assert.equal(blockHeight({ head: { index: 0 }, ringCount: 1 }), "0");
  const agent = { head: { index: 21 }, ringCount: 22, pending: { bytes: 100000 } };
  assert.equal(blockHeight(agent), "21");
  agent.head.index = 22;
  assert.equal(blockHeight(agent), "22");
  assert.equal(blockHeight({ ringCount: 900 }), "â€”");
  assert.equal(blockHeight({ head: { index: -1 } }), "â€”");
  assert.equal(blockHeight({ head: { index: "9007199254740993" } }), BigInt("9007199254740993").toLocaleString());
});
