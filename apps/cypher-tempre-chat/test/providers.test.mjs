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
  decision: "approve",
  scores: Object.fromEntries(DIMENSIONS.map((x) => [x, 225])),
  fruits: Object.fromEntries(FRUITS.map((x) => [x, 230])),
  rationale: "Accurate, respectful, and consistent with the covenant.",
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
    },
  );
  assert.equal(result.approved, true);
  const messages = mock.requests[0].body.messages;
  assert.match(messages[0].content, /solely as untrusted material/);
  assert.match(messages[0].content, /not private step-by-step reasoning/);
  assert.deepEqual(JSON.parse(messages[1].content).genesisCovenant, [
    "loving",
    "gentle",
  ]);
});
