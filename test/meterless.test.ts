import { test } from "node:test";
import assert from "node:assert/strict";
import { MeterlessProvider, MeterlessError, normalizeBaseUrl, parseConnectLink, messageText } from "../src/meterless/provider.ts";
import { startMockRuntime } from "./support/mock-meterless.ts";

test("normalizeBaseUrl accepts the usual pastes and never doubles /v1", () => {
  const want = "http://127.0.0.1:8088/v1";
  for (const input of [
    "127.0.0.1:8088",
    "http://127.0.0.1:8088",
    "http://127.0.0.1:8088/",
    "http://127.0.0.1:8088/v1",
    "http://127.0.0.1:8088/v1/",
    "http://127.0.0.1:8088/v1/chat/completions",
    "http://127.0.0.1:8088/v1/models",
    "http://127.0.0.1:8088/healthz",
    "http://127.0.0.1:8088/v1/v1",
  ]) {
    assert.equal(normalizeBaseUrl(input), want, input);
  }
  assert.equal(normalizeBaseUrl(""), want);
});

test("parseConnectLink takes the base URL from the origin and the token from k", () => {
  assert.deepEqual(parseConnectLink("http://192.168.1.5:8088/connect#k=abc123"), { baseUrl: "http://192.168.1.5:8088/v1", token: "abc123" });
  assert.equal(parseConnectLink("http://127.0.0.1:8088/v1"), null);
});

test("the placeholder token is refused", () => {
  assert.throws(() => new MeterlessProvider({ token: "rt-local" }), MeterlessError);
});

test("a wrong token shows unauthorized, not offline", async () => {
  const runtime = await startMockRuntime("good-token");
  try {
    const provider = new MeterlessProvider({ baseUrl: runtime.baseUrl, token: "wrong" });
    assert.equal((await provider.status()).status, "unauthorized");
  } finally {
    await runtime.close();
  }
});

test("the right token shows online and lists every route, unknown ones included", async () => {
  const runtime = await startMockRuntime("good-token");
  try {
    const provider = new MeterlessProvider({ baseUrl: runtime.baseUrl, token: "good-token" });
    const { status, models } = await provider.status();
    assert.equal(status, "online");
    assert.deepEqual(models, ["meterless/auto", "meterless/fast", "local-runtime/llama-3.2-3b"]);
    assert.equal(runtime.requests.at(-1)!.headers["meterless-app"], "sql-noir");
  } finally {
    await runtime.close();
  }
});

test("nothing listening is offline", async () => {
  const provider = new MeterlessProvider({ baseUrl: "http://127.0.0.1:9/v1", token: "t" });
  assert.equal((await provider.status()).status, "offline");
});

test("a plain text request on meterless/auto returns a string, with the contract headers", async () => {
  const runtime = await startMockRuntime("good-token");
  try {
    const provider = new MeterlessProvider({ baseUrl: runtime.baseUrl, token: "good-token" });
    const result = await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    assert.equal(result.message.content, "The connection works.");
    assert.equal(result.model, "nvidia/nemotron-3.5-lightning-30b-a3b");
    const sent = runtime.requests.at(-1)!;
    assert.equal(sent.body.model, "meterless/auto");
    assert.equal(sent.body.messages[0].content, "hello");
    assert.equal(sent.headers["meterless-scope"], "user");
    assert.equal(sent.headers["meterless-app"], "sql-noir");
    assert.equal(sent.headers.authorization, "Bearer good-token");
  } finally {
    await runtime.close();
  }
});

test("tool calls come back as tool_calls", async () => {
  const runtime = await startMockRuntime("good-token");
  try {
    const provider = new MeterlessProvider({ baseUrl: runtime.baseUrl, token: "good-token" });
    const result = await provider.chat({
      messages: [{ role: "user", content: "run SELECT 1" }],
      tools: [{ type: "function", function: { name: "run_sql", description: "Run SQL", parameters: { type: "object", properties: { sql: { type: "string" } } } } }],
    });
    assert.equal(result.message.tool_calls?.[0].function.name, "run_sql");
    assert.deepEqual(JSON.parse(result.message.tool_calls![0].function.arguments), { sql: "SELECT 1" });
  } finally {
    await runtime.close();
  }
});

test("a 429 is retried after 2, 4 and 8 seconds, then surfaces", async () => {
  const runtime = await startMockRuntime("good-token");
  const waits: number[] = [];
  try {
    const provider = new MeterlessProvider({ baseUrl: runtime.baseUrl, token: "good-token", sleep: async (ms) => void waits.push(ms) });
    runtime.failNext429 = 2;
    assert.equal((await provider.chat({ messages: [{ role: "user", content: "hi" }] })).message.content, "The connection works.");
    assert.deepEqual(waits, [2000, 4000]);
    runtime.failNext429 = 4;
    await assert.rejects(provider.chat({ messages: [{ role: "user", content: "hi" }] }), /HTTP 429/);
  } finally {
    await runtime.close();
  }
});

test("messageText flattens content parts", () => {
  assert.equal(messageText({ content: [{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }] }), "ab");
  assert.equal(messageText({ content: null }), "");
});
