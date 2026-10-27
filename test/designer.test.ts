import { test } from "node:test";
import assert from "node:assert/strict";
import { MeterlessProvider } from "../src/meterless/provider.ts";
import { Trace } from "../src/game/trace.ts";
import { designCase } from "../src/agents/designer.ts";
import type { Runner } from "../src/game/cases.ts";
import { startMockRuntime } from "./support/mock-meterless.ts";

const DRAFT = {
  title: "Broken promises",
  story: "The complaints desk keeps a list of excuses. The ones that start the same way tell the story.",
  question: "List every return reason whose description starts with \"Did not\".",
  answerSql: "SELECT r_reason_desc FROM TPCDS_DB.reason WHERE r_reason_desc LIKE 'Did not%'",
  orderMatters: false,
  skills: ["filter"],
  level: 1,
  hints: ["The reasons are in TPCDS_DB.reason.", "LIKE with % at the end matches a prefix."],
};

const run: Runner = async () => ({ columns: ["r_reason_desc"], rows: [["Did not like the color"], ["Did not fit"]] });
const SCHEMA = "TPCDS_DB.reason(r_reason_sk, r_reason_id, r_reason_desc)";

test("the designer asks again when Nemotron's reply is cut off before its JSON", async () => {
  let calls = 0;
  const runtime = await startMockRuntime("tok", () => (++calls === 1 ? "<think>A filtering case. The reasons table has" : JSON.stringify(DRAFT)));
  try {
    const provider = new MeterlessProvider({ baseUrl: runtime.baseUrl, token: "tok" });
    const trace = new Trace();
    const { c, attempts } = await designCase({ provider, trace, run, schema: SCHEMA, skill: "filter", level: 1, avoidTitles: [], wait: async () => {} });
    assert.equal(c?.title, "Broken promises");
    assert.equal(attempts.length, 2);
    assert.match(attempts[0].problem ?? "", /no case in it/);
    const chats = runtime.requests.filter((r) => r.path === "/v1/chat/completions");
    assert.equal(chats.length, 2);
    assert.ok(chats.every((r) => r.body.max_tokens >= 4096), "the designer leaves room for reasoning and the draft");
    assert.match(chats[1].body.messages[1].content, /JSON object only/);
    assert.ok(trace.events.some((e) => e.action === "model answered without JSON"));
  } finally {
    await runtime.close();
  }
});

test("when Nightshift can't be reached, the designer waits, retries, and says so", async () => {
  const provider = new MeterlessProvider({ baseUrl: "http://127.0.0.1:9/v1", token: "tok" });
  const waits: number[] = [];
  const { c, attempts } = await designCase({
    provider,
    trace: new Trace(),
    run,
    schema: SCHEMA,
    skill: "filter",
    level: 1,
    avoidTitles: [],
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(c, null);
  assert.equal(attempts.length, 3);
  assert.equal(waits.length, 2);
  assert.match(attempts.at(-1)?.problem ?? "", /Can't reach Nightshift/);
});
