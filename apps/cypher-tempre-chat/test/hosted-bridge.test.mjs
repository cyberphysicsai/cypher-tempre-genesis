import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import {
  createApp,
  parsePublicOrigins,
  publicOriginsFromArgs,
} from "../server.mjs";
import {
  bridgeApiUrl,
  bridgePort,
  isLocalBridgePage,
} from "../public/bridge-connection.js";

const site = "https://cyphertempre.ai";
const alternate = "https://beta.cyphertempre.ai";

async function fixture(t, publicOrigins = []) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-hosted-bridge-"));
  const app = await createApp({
    licenseConfig: { mode: "holdings", required: false },
    dataDir,
    publicOrigins,
    pairingCode: "HOSTED-TEST",
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => {
      app.server.closeAllConnections();
      app.server.close(resolve);
    });
    const resolved = path.resolve(dataDir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith("ct-hosted-bridge-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { base, app };
}

test("hosted API targets are restricted to a numeric loopback port", () => {
  assert.equal(
    bridgeApiUrl("/api/pair", site),
    "http://127.0.0.1:8790/api/pair",
  );
  assert.equal(
    bridgeApiUrl("/api/state", site, "9123"),
    "http://127.0.0.1:9123/api/state",
  );
  assert.equal(bridgePort(" 9123 "), "9123");
  for (const port of [
    "0",
    "65536",
    "1e4",
    "80.0",
    "http://evil.example",
    "8790@evil.example",
    "8790/path",
    "",
    "-1",
  ])
    assert.throws(() => bridgeApiUrl("/api/pair", site, port));
  for (const endpoint of [
    "https://evil.example/api/pair",
    "//evil.example/api/pair",
    "/api/../pair",
    "/api/pair?redirect=evil",
    "/api/pair#x",
    "/api/%2f",
  ])
    assert.throws(() => bridgeApiUrl(endpoint, site));
  assert.throws(() => bridgeApiUrl("/api/pair", "http://cyphertempre.ai"));
});

test("local serving keeps same-origin API requests", () => {
  assert.equal(bridgeApiUrl('/api/local-pairing', 'http://127.0.0.1:8790'), '/api/local-pairing');
  assert.equal(bridgeApiUrl('/api/local-resume', 'http://127.0.0.1:8790'), '/api/local-resume');
  for (const path of ['/api/local--resume', '/api/-resume', '/api/local-/resume', '/api/local-resume?secret=x'])
    assert.throws(() => bridgeApiUrl(path, 'http://127.0.0.1:8790'));
  for (const origin of [
    "http://127.0.0.1:8790",
    "http://localhost:8790",
    "http://[::1]:8790",
  ]) {
    assert.equal(isLocalBridgePage(origin), true);
    assert.equal(bridgeApiUrl("/api/state", origin), "/api/state");
  }
  for (const origin of [
    site,
    "http://127.0.0.1.evil.example",
    "http://localhost.evil.example",
    "http://192.168.0.1",
  ])
    assert.equal(isLocalBridgePage(origin), false);
});

test("only exact HTTPS origins can be opted into through environment or CLI", () => {
  assert.deepEqual(parsePublicOrigins(`${site},${alternate},${site}`), [
    site,
    alternate,
  ]);
  assert.deepEqual(
    publicOriginsFromArgs(["--public-origin", alternate], site),
    [site, alternate],
  );
  for (const origin of [
    "*",
    "https://*.cyphertempre.ai",
    "http://cyphertempre.ai",
    `${site}/`,
    `${site}/path`,
    `${site}?q=1`,
    `${site}#x`,
    "https://name:pass@cyphertempre.ai",
    "null",
  ])
    assert.throws(() => parsePublicOrigins(origin));
  assert.throws(() => publicOriginsFromArgs(["--public-origin"]));
  assert.throws(() => publicOriginsFromArgs(["--other", site]));
});

test("hosted origins are denied by default and near-match origins remain denied", async (t) => {
  const defaultBridge = await fixture(t);
  assert.equal(
    (
      await fetch(defaultBridge.base + "/api/status", {
        headers: { Origin: site },
      })
    ).status,
    403,
  );
  const f = await fixture(t, [site]);
  for (const origin of [
    alternate,
    `${site}.evil.example`,
    "https://evil-cyphertempre.ai",
    "http://cyphertempre.ai",
    "null",
  ]) {
    const response = await fetch(f.base + "/api/status", {
      headers: { Origin: origin },
    });
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});

test("approved hosted preflights allow only expected methods and headers", async (t) => {
  const f = await fixture(t, [site]);
  const response = await fetch(f.base + "/api/pair", {
    method: "OPTIONS",
    headers: {
      Origin: site,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
      "Access-Control-Request-Private-Network": "true",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), site);
  assert.equal(
    response.headers.get("access-control-allow-private-network"),
    "true",
  );
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  for (const headers of [
    { "Access-Control-Request-Method": "DELETE" },
    {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "x-arbitrary",
    },
  ]) {
    const rejected = await fetch(f.base + "/api/pair", {
      method: "OPTIONS",
      headers: { Origin: site, ...headers },
    });
    assert.equal(rejected.status, 403);
    assert.equal(
      rejected.headers.get("access-control-allow-private-network"),
      null,
    );
  }
});

test("a paired hosted session cannot be reused from another approved origin or localhost", async (t) => {
  const f = await fixture(t, [site, alternate]);
  const pair = await fetch(f.base + "/api/pair", {
    method: "POST",
    headers: { Origin: site, "Content-Type": "application/json" },
    body: JSON.stringify({ code: "HOSTED-TEST" }),
  });
  assert.equal(pair.status, 200);
  const { token } = await pair.json();
  const authorization = `Bearer ${token}`;
  assert.equal(
    (
      await fetch(f.base + "/api/state", {
        headers: { Origin: site, authorization },
      })
    ).status,
    200,
  );
  for (const origin of [alternate, f.base, undefined]) {
    const rejected = await fetch(f.base + "/api/state", {
      headers: { authorization, ...(origin ? { Origin: origin } : {}) },
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, "SESSION_ORIGIN_REJECTED");
  }
  assert.equal(
    (
      await fetch(f.base + "/api/unpair", {
        method: "POST",
        headers: {
          Origin: site,
          authorization,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    200,
  );
});

test("same-origin local POST pairing supports GET requests without Origin", async (t) => {
  const f = await fixture(t);
  const pair = await fetch(f.base + "/api/pair", {
    method: "POST",
    headers: { Origin: f.base, "Content-Type": "application/json" },
    body: JSON.stringify({ code: "HOSTED-TEST" }),
  });
  assert.equal(pair.status, 200);
  const { token } = await pair.json();
  assert.equal(
    (
      await fetch(f.base + "/api/state", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    200,
  );
});

test("auditor directory serves an isolated same-origin iframe without exposing local files", async (t) => {
  const f = await fixture(t);
  const main = await fetch(f.base + "/");
  assert.equal(main.status, 200);
  assert.match(main.headers.get("content-security-policy"), /frame-src 'self'/);
  assert.match(
    main.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  const audit = await fetch(f.base + "/audit/");
  const direct = await fetch(f.base + "/audit/index.html");
  assert.equal(audit.status, 200);
  assert.equal(await audit.text(), await direct.text());
  assert.match(
    audit.headers.get("content-security-policy"),
    /frame-ancestors 'self'/,
  );
  assert.match(
    audit.headers.get("content-security-policy"),
    /connect-src 'self' http:\/\/127\.0\.0\.1:8788 http:\/\/localhost:8788;/,
  );
  const script = await fetch(f.base + "/audit/app.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(f.base + "/audit/%5c..%5cserver.mjs")).status, 404);
  assert.equal(
    (await fetch(f.base + "/.local/bridge-identity.json")).status,
    404,
  );
});
