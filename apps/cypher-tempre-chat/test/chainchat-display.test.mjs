import test from "node:test";
import assert from "node:assert/strict";
import { blockHeight, formatTokenBalance, requiresHoldings } from "../public/chainchat-display.js";

test("current block height is the last sealed index, including genesis zero", () => {
  assert.equal(blockHeight(null), "—");
  assert.equal(blockHeight({ head: { index: 2 } }, false), "—");
  assert.equal(blockHeight({ head: { index: 0 }, ringCount: 1 }), "0");
  const agent = { head: { index: 21 }, ringCount: 22, pending: { bytes: 100000 } };
  assert.equal(blockHeight(agent), "21");
  agent.head.index = 22;
  assert.equal(blockHeight(agent), "22");
  assert.equal(blockHeight({ ringCount: 900 }), "—");
  assert.equal(blockHeight({ head: { index: -1 } }), "—");
  assert.equal(blockHeight({ head: { index: "9007199254740993" } }), BigInt("9007199254740993").toLocaleString());
});

test("CPHY balance display retains precision at the eligibility boundary", () => {
  assert.equal(formatTokenBalance("21000000000000000000000"), (21000).toLocaleString());
  assert.equal(formatTokenBalance("20999999999999999999999"), (20999).toLocaleString() + ".999999999999999999");
  assert.equal(formatTokenBalance("1"), "0.000000000000000001");
  assert.equal(formatTokenBalance(null), "—");
});

test("history inspection, existing-chain pairing and export remain available without holdings", () => {
  for (const path of ["/api/state", "/api/history", "/api/status"])
    assert.equal(requiresHoldings(path), false);
  for (const path of ["/api/pair", "/api/unpair", "/api/agents/pair", "/api/agents/select", "/api/verify", "/api/faculties/preview", "/api/faculties/export", "/api/license/verify", "/api/license/check", "/api/license/logout"])
    assert.equal(requiresHoldings(path, {}), false);
  assert.equal(requiresHoldings("/api/provider", { disconnect: true }), false);
  for (const path of ["/api/chat", "/api/continuum", "/api/continuum/flush", "/api/agents", "/api/faculties/import", "/api/provider", "/api/loadout", "/api/settings"])
    assert.equal(requiresHoldings(path, {}), true);
});
