import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  validateProvider,
  generate,
  review,
  parseReview,
  FRUITS,
  DIMENSIONS,
  ProviderError,
  assertCredentialIsolation,
} from "../lib/providers.mjs";

async function localProvider(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      url: req.url,
      headers: req.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
    });
    handler(req, res, requests.at(-1));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}
const respond = (res, data, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};
const goodReview = () => ({
  usedRings: [],
  decision: "approve",
  scores: Object.fromEntries(DIMENSIONS.map((x) => [x, 225])),
  fruits: Object.fromEntries(FRUITS.map((x) => [x, 230])),
  rationale: "Accurate, respectful, and consistent with the covenant.",
});

test("every provider rejects reflected authentication before returning model output", async (t) => {
  const secret = 'synthetic-key-with-"quotes"-and-\\slashes';
  for (const provider of ["openai", "compatible", "anthropic", "gemini"]) {
    await t.test(provider, async (t) => {
      const mock = await localProvider(t, (req, res) => {
        const reflected =
          req.headers.authorization ||
          req.headers["x-api-key"] ||
          req.headers["x-goog-api-key"];
        const responses = {
          openai: {
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: reflected }],
              },
            ],
          },
          compatible: {
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: reflected },
              },
            ],
          },
          anthropic: {
            stop_reason: "end_turn",
            content: [{ type: "text", text: reflected }],
          },
          gemini: {
            candidates: [
              {
                finishReason: "STOP",
                content: { parts: [{ text: reflected }] },
              },
            ],
          },
        };
        respond(res, responses[provider]);
      });
      await assert.rejects(
        generate(
          { provider, model: "fixture", apiKey: secret, baseUrl: mock.baseUrl },
          { messages: [{ role: "user", content: "Synthetic request" }] },
        ),
        (error) =>
          error.code === "PROVIDER_CREDENTIAL_REFLECTION" &&
          !error.message.includes(secret),
      );
      assert.ok(!JSON.stringify(mock.requests[0].body).includes(secret));
    });
  }
});

test("reflected review rationale is held and cannot become a gate assessment", async (t) => {
  const secret = 'synthetic-review-"credential"-with-\\slashes';
  const mock = await localProvider(t, (req, res) =>
    respond(res, {
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              ...goodReview(),
              rationale: req.headers.authorization,
            }),
          },
        },
      ],
    }),
  );
  await assert.rejects(
    review(
      {
        provider: "compatible",
        model: "fixture",
        apiKey: secret,
        baseUrl: mock.baseUrl,
      },
      {
        input: "Synthetic request",
        candidate: "Synthetic candidate",
        covenant: [...FRUITS],
      },
    ),
    (error) =>
      error.code === "PROVIDER_CREDENTIAL_REFLECTION" &&
      !error.message.includes(secret),
  );
});

test("credential guard checks nested raw strings and keys, including short credentials, without modifying safe output", () => {
  for (const secret of ["x", 'synthetic-"quoted"-key', "synthetic-\\-key"]) {
    for (const value of [
      { text: "prefix" + secret + "suffix" },
      { metadata: [{ [secret]: "value" }] },
    ])
      assert.throws(
        () => assertCredentialIsolation({ apiKey: secret }, value),
        { code: "PROVIDER_CREDENTIAL_REFLECTION" },
      );
  }
  const safe = { text: "A safe response.", usage: { output_tokens: 10 } };
  const original = structuredClone(safe);
  assertCredentialIsolation({ apiKey: "synthetic-not-present" }, safe);
  assert.deepEqual(safe, original);
  assertCredentialIsolation({ apiKey: "" }, safe);
});

test("OpenCode Go receives an honest client name and private random provider-session identifier only at its official endpoint", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options });
    const body = JSON.parse(options.body);
    const text = body.instructions.includes(
      "independent pre-release covenant reviewer",
    )
      ? JSON.stringify(goodReview())
      : "Safe fixture answer.";
    return new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
      }),
    );
  });
  const config = {
    provider: "openai",
    model: "fixture",
    apiKey: "synthetic-opencode-key",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
  };
  await generate(config, {
    messages: [{ role: "user", content: "First request" }],
  });
  await review(config, {
    input: "First request",
    candidate: "Safe answer",
    covenant: [...FRUITS],
  });
  await generate(
    { ...config },
    { messages: [{ role: "user", content: "Another session" }] },
  );
  const first = requests[0].headers["x-opencode-session"];
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(requests[0].headers["user-agent"], "CypherTempre-ChainChat");
  assert.equal(requests[1].headers["x-opencode-session"], first);
  assert.notEqual(requests[2].headers["x-opencode-session"], first);
  assert.equal(requests[0].url, config.baseUrl + "/responses");
  for (const baseUrl of [
    "https://opencode.ai.evil.example/inference/go/openai/v1",
    "https://opencode.ai/other/v1",
    "https://opencode.ai:444/inference/go/openai/v1",
  ]) {
    await generate(
      { ...config, baseUrl },
      { messages: [{ role: "user", content: "Unrelated endpoint" }] },
    );
    assert.equal(requests.at(-1).headers["x-opencode-session"], undefined);
    assert.equal(requests.at(-1).headers["user-agent"], undefined);
  }
});

test("only official Go Responses Muse Contributor reviews receive the bounded 8192-token allowance", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const text = JSON.stringify(goodReview());
    return new Response(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
        choices: [{ finish_reason: "stop", message: { content: text } }],
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
        candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
      }),
    );
  });
  const eligible = {
    provider: "openai",
    model: "muse-spark-1.3-contributor",
    apiKey: "synthetic-review-budget-key",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
  };
  const cases = [
    [eligible, "max_output_tokens", 8192],
    [
      {
        ...eligible,
        baseUrl: "https://opencode.ai:443/inference/go/openai/v1/",
      },
      "max_output_tokens",
      8192,
    ],
    [{ ...eligible, model: "another-model" }, "max_output_tokens", 2048],
    [
      { ...eligible, baseUrl: "https://api.openai.com/v1" },
      "max_output_tokens",
      2048,
    ],
    [
      {
        ...eligible,
        baseUrl: "https://opencode.ai.evil.example/inference/go/openai/v1",
      },
      "max_output_tokens",
      2048,
    ],
    [
      {
        ...eligible,
        baseUrl: "https://opencode.ai:444/inference/go/openai/v1",
      },
      "max_output_tokens",
      2048,
    ],
    [
      { ...eligible, baseUrl: "https://opencode.ai/inference/go/other/v1" },
      "max_output_tokens",
      2048,
    ],
    [
      { ...eligible, baseUrl: "https://opencode.ai/inference/go/openai/v10" },
      "max_output_tokens",
      2048,
    ],
    [{ ...eligible, provider: "compatible" }, "max_tokens", 2048],
    [
      { provider: "anthropic", model: "fixture", apiKey: eligible.apiKey },
      "max_tokens",
      2048,
    ],
    [
      { provider: "gemini", model: "fixture", apiKey: eligible.apiKey },
      "maxOutputTokens",
      2048,
    ],
  ];
  for (const [config, field, expected] of cases) {
    await review(config, {
      input: "Synthetic request",
      candidate: "Safe answer",
      covenant: [...FRUITS],
    });
    const body = requests.at(-1).body;
    assert.equal(
      (body.generationConfig || body)[field],
      expected,
      `${config.provider} ${config.baseUrl} ${config.model}`,
    );
  }
  await generate(eligible, {
    messages: [{ role: "user", content: "Ordinary generation" }],
  });
  assert.equal(requests.at(-1).body.max_output_tokens, 4096);
  await generate(eligible, {
    messages: [{ role: "user", content: "Bounded generation" }],
    maxTokens: 512,
  });
  assert.equal(requests.at(-1).body.max_output_tokens, 512);
});

test("Muse review exhaustion remains held at its larger allowance", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(JSON.parse(options.body).max_output_tokens, 8192);
    return new Response(
      JSON.stringify({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: JSON.stringify(goodReview()) },
            ],
          },
        ],
      }),
    );
  });
  await assert.rejects(
    review(
      {
        provider: "openai",
        model: "muse-spark-1.3-contributor",
        apiKey: "synthetic-budget-key",
        baseUrl: "https://opencode.ai/inference/go/openai/v1",
      },
      {
        input: "Synthetic request",
        candidate: "Safe answer",
        covenant: [...FRUITS],
      },
    ),
    { code: "PROVIDER_INCOMPLETE" },
  );
});

test("review evidence references are explicit unique canonical indices, never every retrieved item by default", () => {
  const evidence = [1, 2].map((index) => ({
    index,
    hash: "ab".repeat(32),
    text: "Canonical fixture evidence",
    truncated: false,
  }));
  assert.deepEqual(
    parseReview(JSON.stringify({ ...goodReview(), usedRings: [2] }), evidence)
      .usedRings,
    [2],
  );
  for (const usedRings of [
    undefined,
    null,
    "1",
    [1, 1],
    [-1],
    [1.2],
    ["1"],
    [3],
  ])
    assert.throws(
      () =>
        parseReview(JSON.stringify({ ...goodReview(), usedRings }), evidence),
      { code: "GATE_INVALID_EVIDENCE" },
    );
});

test("an active credential in prompt or review context is held before any network request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    throw new Error("Network should not be reached.");
  });
  const config = {
    provider: "openai",
    model: "fixture",
    apiKey: "synthetic-active-key-not-real",
  };
  await assert.rejects(
    generate(config, {
      system: "Context includes " + config.apiKey,
      messages: [{ role: "user", content: "Synthetic request" }],
    }),
    { code: "PROVIDER_CREDENTIAL_REFLECTION" },
  );
  await assert.rejects(
    review(config, {
      input: "Synthetic request",
      candidate: "Safe answer",
      covenant: [...FRUITS],
      recentConversation: [{ role: "user", content: config.apiKey }],
    }),
    { code: "PROVIDER_CREDENTIAL_REFLECTION" },
  );
  assert.equal(calls, 0);
});

test("every provider normalizes model text while preserving credentials and request identity", async (t) => {
  const priorName = ["qua", "lia"].join("");
  const priorGate = ["Po", "Q"].join("");
  const retired = new RegExp(`${priorName}|${priorGate}`, "i");
  for (const provider of ["openai", "compatible", "anthropic", "gemini"]) {
    await t.test(provider, async (t) => {
      const responses = {
        openai: {
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Careful answer." }],
            },
          ],
        },
        compatible: {
          choices: [
            { finish_reason: "stop", message: { content: "Careful answer." } },
          ],
        },
        anthropic: {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Careful answer." }],
        },
        gemini: {
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "Careful answer." }] },
            },
          ],
        },
      };
      const mock = await localProvider(t, (_req, res) =>
        respond(res, responses[provider]),
      );
      const config = {
        provider,
        model: `model-${priorGate}`,
        apiKey: `secret-${priorName}`,
        baseUrl: mock.baseUrl,
      };
      const args = {
        system: `The installed skill describes Proof of ${priorName}.`,
        messages: [
          {
            role: "assistant",
            content: `Past ${priorGate} decisions remain immutable.`,
          },
          {
            role: "user",
            content: `Explain ${priorGate.toLowerCase()}_verdict with kindness.`,
          },
        ],
      };
      const before = JSON.stringify({ config, args });
      await generate(config, args);
      const request = mock.requests[0];
      const { model, ...context } = request.body;
      assert.doesNotMatch(JSON.stringify(context), retired);
      if (provider === "gemini")
        assert.ok(request.url.includes(encodeURIComponent(config.model)));
      else assert.equal(model, config.model);
      assert.equal(
        request.headers.authorization ||
          request.headers["x-api-key"] ||
          request.headers["x-goog-api-key"],
        provider === "openai" || provider === "compatible"
          ? `Bearer ${config.apiKey}`
          : config.apiKey,
      );
      assert.equal(JSON.stringify({ config, args }), before);
    });
  }
});

test("independent review normalizes legacy covenant, candidate and perspective context", async (t) => {
  const priorName = ["qua", "lia"].join("");
  const priorGate = ["Po", "Q"].join("");
  const mock = await localProvider(t, (_req, res) =>
    respond(res, {
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(goodReview()) },
        },
      ],
    }),
  );
  const args = {
    input: `Discuss Proof of ${priorName}.`,
    candidate: `I will assess ${priorGate} with care.`,
    covenant: ["love", `The inherited ${priorGate} creed`],
    perspectives: [{ [priorGate.toLowerCase()]: priorName }],
  };
  const before = JSON.stringify(args);
  const result = await review(
    { provider: "compatible", model: "local-model", baseUrl: mock.baseUrl },
    args,
  );
  assert.equal(result.approved, true);
  assert.doesNotMatch(
    JSON.stringify(mock.requests[0].body),
    new RegExp(`${priorName}|${priorGate}`, "i"),
  );
  assert.equal(JSON.stringify(args), before);
});

test("standalone generation and parsed public assessments return current terminology", async (t) => {
  const priorName = ["qua", "lia"].join("");
  const priorGate = ["Po", "Q"].join("");
  const text = `Proof of ${priorName} uses ${priorGate.toLowerCase()}.py with ${priorGate}.`;
  const mock = await localProvider(t, (_req, res) =>
    respond(res, {
      choices: [{ finish_reason: "stop", message: { content: text } }],
    }),
  );
  const response = await generate(
    { provider: "compatible", model: "local-model", baseUrl: mock.baseUrl },
    { messages: [{ role: "user", content: "Explain the conscience." }] },
  );
  assert.equal(response.text, "Proof of interaction uses PoI.py with PoI.");
  const result = goodReview();
  result.rationale = text;
  assert.equal(parseReview(JSON.stringify(result)).rationale, response.text);
  assert.equal(result.rationale, text);
});

test("provider configuration requires secure origins and validates models and keys", () => {
  assert.equal(
    validateProvider({
      provider: "openai",
      model: "chosen-model",
      apiKey: "memory-key",
    }).baseUrl,
    "https://api.openai.com/v1",
  );
  assert.equal(
    validateProvider({ provider: "compatible", model: "local/model" }).apiKey,
    "",
  );
  for (const baseUrl of [
    "http://remote.example/v1",
    "ftp://localhost/",
    "https://user:pass@example.test",
    "https://example.test/?key=secret",
    "https://example.test/#fragment",
    "http://127.0.0.1:0",
    "http://localhost.evil.test",
    "https://example.test\\evil",
  ]) {
    assert.throws(
      () =>
        validateProvider({
          provider: "compatible",
          model: "m",
          apiKey: "key",
          baseUrl,
        }),
      ProviderError,
    );
  }
  assert.throws(
    () => validateProvider({ provider: "__proto__", model: "m" }),
    ProviderError,
  );
  assert.throws(
    () => validateProvider({ provider: "openai", model: "m" }),
    ProviderError,
  );
  assert.throws(
    () =>
      validateProvider({
        provider: "openai",
        model: "m",
        apiKey: "key\r\nx-evil: yes",
      }),
    ProviderError,
  );
  assert.throws(
    () =>
      validateProvider({
        provider: "gemini",
        model: "../models/bad",
        apiKey: "key",
      }),
    ProviderError,
  );
});

test("OpenAI Responses uses stateless inputs and extracts only assistant output text", async (t) => {
  const mock = await localProvider(t, (_req, res) =>
    respond(res, {
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ text: "private" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer." }],
        },
      ],
      usage: { input_tokens: 13, output_tokens: 3, secret: "hidden" },
    }),
  );
  const result = await generate(
    {
      provider: "openai",
      model: "user-chosen",
      apiKey: "memory-key",
      baseUrl: mock.baseUrl,
    },
    {
      system: "Covenant",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 512,
    },
  );
  assert.deepEqual(result, {
    text: "Answer.",
    usage: { input_tokens: 13, output_tokens: 3 },
  });
  assert.equal(mock.requests[0].url, "/v1/responses");
  assert.equal(mock.requests[0].headers.authorization, "Bearer memory-key");
  assert.equal(mock.requests[0].body.store, false);
  assert.equal(mock.requests[0].body.max_output_tokens, 512);
  assert.equal(mock.requests[0].body.instructions, "Covenant");
});

test("compatible transport preserves model, system and full chat history", async (t) => {
  const mock = await localProvider(t, (_req, res) =>
    respond(res, {
      choices: [
        { finish_reason: "stop", message: { content: "Local answer" } },
      ],
    }),
  );
  await generate(
    {
      provider: "compatible",
      model: "vendor/local-model",
      baseUrl: mock.baseUrl,
    },
    {
      system: "Covenant",
      messages: [
        { role: "user", content: "First" },
        { role: "assistant", content: "Earlier" },
        { role: "user", content: "Next" },
      ],
    },
  );
  assert.equal(mock.requests[0].url, "/v1/chat/completions");
  assert.equal(mock.requests[0].headers.authorization, undefined);
  assert.equal(mock.requests[0].body.messages.length, 4);
  assert.equal(mock.requests[0].body.model, "vendor/local-model");
});

test("Anthropic uses separate system, current version header and text blocks", async (t) => {
  const mock = await localProvider(t, (_req, res) =>
    respond(res, {
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "not exposed" },
        { type: "text", text: "Hello" },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
  );
  const result = await generate(
    {
      provider: "anthropic",
      model: "user-claude",
      apiKey: "ant-key",
      baseUrl: mock.baseUrl,
    },
    { system: "Values", messages: [{ role: "user", content: "Hello" }] },
  );
  assert.equal(result.text, "Hello");
  assert.equal(mock.requests[0].url, "/v1/messages");
  assert.equal(mock.requests[0].headers["x-api-key"], "ant-key");
  assert.equal(mock.requests[0].headers["anthropic-version"], "2026-10-21");
  assert.equal(mock.requests[0].body.system, "Values");
  assert.equal(mock.requests[0].body.temperature, undefined);
});

test("Gemini credentials stay in headers and thought parts never become answer text", async (t) => {
  const mock = await localProvider(t, (_req, res) =>
    respond(res, {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [{ thought: true, text: "hidden" }, { text: "Visible" }],
          },
        },
      ],
      usageMetadata: { totalTokenCount: 20 },
    }),
  );
  const result = await generate(
    {
      provider: "gemini",
      model: "models/custom-gemini",
      apiKey: "g-key",
      baseUrl: mock.baseUrl,
    },
    {
      system: "Values",
      messages: [
        { role: "user", content: "A" },
        { role: "assistant", content: "B" },
        { role: "user", content: "C" },
      ],
    },
  );
  assert.equal(result.text, "Visible");
  assert.equal(
    mock.requests[0].url,
    "/v1/models/custom-gemini:generateContent",
  );
  assert.equal(mock.requests[0].headers["x-goog-api-key"], "g-key");
  assert.equal(mock.requests[0].body.contents[1].role, "model");
});

test("errors do not echo provider bodies or keys", async (t) => {
  const mock = await localProvider(t, (_req, res) =>
    respond(res, { error: { message: "secret-key-in-provider-body" } }, 401),
  );
  await assert.rejects(
    generate(
      {
        provider: "compatible",
        model: "m",
        apiKey: "actual-secret",
        baseUrl: mock.baseUrl,
      },
      { messages: [{ role: "user", content: "a" }] },
    ),
    (error) =>
      error.code === "PROVIDER_HTTP_ERROR" && !/secret/.test(error.message),
  );
});

test("credential-bearing redirects are not followed", async (t) => {
  let destinationCalls = 0;
  const destination = await localProvider(t, (_req, res) => {
    destinationCalls++;
    respond(res, {});
  });
  const origin = await localProvider(t, (_req, res) => {
    res.writeHead(307, { location: `${destination.baseUrl}/stolen` });
    res.end();
  });
  await assert.rejects(
    generate(
      {
        provider: "compatible",
        model: "m",
        apiKey: "secret",
        baseUrl: origin.baseUrl,
      },
      { messages: [{ role: "user", content: "a" }] },
    ),
    { code: "PROVIDER_CONNECTION_ERROR" },
  );
  assert.equal(destinationCalls, 0);
});

test("incomplete and tool-call responses are held", async (t) => {
  const mock = await localProvider(t, (_req, res) =>
    respond(res, {
      choices: [{ finish_reason: "length", message: { content: "partial" } }],
    }),
  );
  await assert.rejects(
    generate(
      { provider: "compatible", model: "m", baseUrl: mock.baseUrl },
      { messages: [{ role: "user", content: "a" }] },
    ),
    { code: "PROVIDER_INCOMPLETE" },
  );
});

test("request cancellation is surfaced without provider detail", async (t) => {
  const mock = await localProvider(t, (_req, _res) => {});
  const controller = new AbortController();
  const promise = generate(
    { provider: "compatible", model: "m", baseUrl: mock.baseUrl },
    { messages: [{ role: "user", content: "a" }], signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(promise, { code: "REQUEST_CANCELLED" });
});

test("review rejects every missing, non-integer, out-of-range or low fruitage score", () => {
  assert.equal(parseReview(JSON.stringify(goodReview())).approved, true);
  for (const fruit of FRUITS) {
    const low = goodReview();
    low.fruits[fruit] = 179;
    assert.equal(parseReview(JSON.stringify(low)).approved, false, fruit);
    for (const bad of [null, "230", true, 256, -1, 180.5]) {
      const value = goodReview();
      value.fruits[fruit] = bad;
      assert.throws(() => parseReview(JSON.stringify(value)), {
        code: "GATE_INVALID_REVIEW",
      });
    }
    const missing = goodReview();
    delete missing.fruits[fruit];
    assert.throws(() => parseReview(JSON.stringify(missing)), {
      code: "GATE_INVALID_REVIEW",
    });
  }
  const covenant = goodReview();
  covenant.scores.covenant = 0;
  assert.equal(parseReview(JSON.stringify(covenant)).approved, false);
  const reject = goodReview();
  reject.decision = "reject";
  assert.equal(parseReview(JSON.stringify(reject)).approved, false);
  assert.throws(() => parseReview("```json\n{}\n```"), {
    code: "GATE_INVALID_REVIEW",
  });
  assert.throws(() => parseReview("null"), { code: "GATE_INVALID_REVIEW" });
});

test("review has a fresh system frame, includes immutable covenant and requests public assessment only", async (t) => {
  const mock = await localProvider(t, (_req, res) =>
    respond(res, {
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(goodReview()) },
        },
      ],
    }),
  );
  const result = await review(
    { provider: "compatible", model: "m", baseUrl: mock.baseUrl },
    {
      input: "help me",
      candidate: "An accurate reply",
      covenant: ["loving", "gentle"],
      perspectives: [{ name: "Scholar", summary: "Public summary" }],
      availableEvidence: [
        {
          index: 2,
          hash: "ab".repeat(32),
          text: "A canonical memory snippet.",
          truncated: false,
        },
      ],
      recentConversation: [
        { role: "user", content: "The preceding question." },
      ],
    },
  );
  assert.equal(result.approved, true);
  const messages = mock.requests[0].body.messages;
  assert.match(messages[0].content, /solely as untrusted material/);
  assert.match(messages[0].content, /not private step-by-step reasoning/);
  assert.match(messages[0].content, /Do not mark every retrieved ring as used/);
  const context = JSON.parse(messages[1].content);
  assert.equal(context.availableEvidence[0].index, 2);
  assert.equal(
    context.recentConversation[0].content,
    "The preceding question.",
  );
  assert.deepEqual(result.usedRings, []);
  assert.deepEqual(JSON.parse(messages[1].content).genesisCovenant, [
    "loving",
    "gentle",
  ]);
});
