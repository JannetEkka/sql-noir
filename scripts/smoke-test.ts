// Smoke test for the laptop: checks Zetaris and Nightshift together, the way
// the game will use them, and records each reply in fixtures/recorded so the
// code can be built against real shapes. Run from the project folder:
//   npm run smoke

import { loadEnv, record } from "./env.ts";
import { ZetarisClient, zetarisConfigFromEnv } from "../src/zetaris/client.ts";
import { MeterlessProvider, meterlessConfigFromEnv, type ToolDefinition } from "../src/meterless/provider.ts";

loadEnv();

type Status = "PASS" | "WARN" | "FAIL";
const results: { status: Status; name: string; detail: string }[] = [];

async function check(name: string, fn: () => Promise<string | { status: Status; detail: string }>): Promise<void> {
  try {
    const out = await fn();
    const { status, detail } = typeof out === "string" ? { status: "PASS" as Status, detail: out } : out;
    results.push({ status, name, detail });
  } catch (err) {
    results.push({ status: "FAIL", name, detail: (err as Error).message });
  }
  const last = results[results.length - 1];
  console.log(`${last.status}  ${last.name}${last.detail ? `  ${last.detail}` : ""}`);
}

const settings = ["ZETARIS_REST_URL", "ZETARIS_ORG_ID", "ZETARIS_API_KEY", "METERLESS_BASE_URL", "METERLESS_RUNTIME_TOKEN", "METERLESS_MODEL"];
await check("Settings in .env", async () => {
  const missing = settings.filter((name) => !process.env[name] || /^your-/.test(process.env[name]!));
  if (missing.length) throw new Error(`missing or still a placeholder: ${missing.join(", ")}`);
  return "all six set";
});

const uiUrl = process.env.ZETARIS_UI_URL || "http://localhost:3000";
await check("Zetaris web interface", async () => {
  const response = await fetch(uiUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${uiUrl}`);
  return uiUrl;
});

const zetaris = new ZetarisClient(zetarisConfigFromEnv());
await check("Zetaris runs SQL over REST", async () => {
  const result = await zetaris.runSql("SELECT 1 AS one");
  record("zetaris-select-1", result.raw);
  if (String(result.rows[0]?.[0]) !== "1") throw new Error(`expected 1, got ${JSON.stringify(result.rows).slice(0, 80)}`);
  return `${result.elapsedMs} ms, columns: ${result.columns ? result.columns.join(", ") : "not in the reply"}`;
});

await check("Zetaris sample data (TPCDS_DB)", async () => {
  const tables = await zetaris.runSql("SHOW LIGHTNING TABLES TPCDS_DB", { limit: 500 });
  record("zetaris-show-tables-tpcds", tables.raw);
  const sample = await zetaris.runSql("SELECT r_reason_sk, r_reason_desc FROM TPCDS_DB.reason ORDER BY r_reason_sk LIMIT 5");
  record("zetaris-reason-sample", sample.raw);
  if (!sample.rows.length) throw new Error("TPCDS_DB.reason returned no rows");
  return `${tables.rows.length} tables listed; reason has rows, e.g. ${JSON.stringify(sample.rows[0])}`;
});

await check("Zetaris refuses a bad query clearly", async () => {
  try {
    const result = await zetaris.runSql("SELECT no_such_column FROM TPCDS_DB.reason LIMIT 1");
    record("zetaris-bad-query", result.raw);
    return { status: "WARN", detail: "no error raised; saved the reply so the error shape can be handled" };
  } catch (err) {
    record("zetaris-bad-query-error", { message: (err as Error).message });
    return `error: ${(err as Error).message.slice(0, 120)}`;
  }
});

const meterless = new MeterlessProvider(meterlessConfigFromEnv());
await check("Nightshift runtime is online", async () => {
  const { status, models } = await meterless.status();
  record("meterless-models", models);
  if (status !== "online") throw new Error(status === "unauthorized" ? "token rejected: copy it again from Nightshift's Console" : `runtime is ${status} at ${meterless.baseUrl}`);
  const routes = models.filter((id) => id.startsWith("meterless/"));
  return `${routes.length} meterless routes: ${routes.join(", ")}`;
});

await check(`Nightshift answers on ${meterless.model}`, async () => {
  const result = await meterless.chat({ messages: [{ role: "user", content: "Reply with one short sentence confirming this connection works." }] });
  record("meterless-chat", result.raw);
  if (!result.message.content) throw new Error("the reply had no text");
  return `model: ${result.model ?? "not reported"}; said: ${result.message.content.slice(0, 80)}`;
});

const runSqlTool: ToolDefinition = {
  type: "function",
  function: {
    name: "run_sql",
    description: "Run one read-only SQL query against the game's data and return the rows.",
    parameters: { type: "object", properties: { sql: { type: "string", description: "One SQL statement" } }, required: ["sql"] },
  },
};
await check("Nightshift passes tool calls through", async () => {
  const result = await meterless.chat({
    messages: [{ role: "user", content: "Use the run_sql tool to run this exact query: SELECT 1 AS one. Do not answer in text." }],
    tools: [runSqlTool],
  });
  record("meterless-tool-call", result.raw);
  const call = result.message.tool_calls?.[0];
  if (!call) return { status: "WARN", detail: `no tool call; it answered in text instead: ${(result.message.content ?? "").slice(0, 80)}` };
  return `${call.function.name}(${call.function.arguments}) via ${result.model ?? "an unreported model"}`;
});

const failed = results.filter((r) => r.status === "FAIL").length;
const warned = results.filter((r) => r.status === "WARN").length;
console.log(`\n${results.length - failed - warned} passed, ${warned} warnings, ${failed} failed.`);
console.log("Replies were saved in fixtures/recorded (no keys or tokens are written there).");
process.exit(failed ? 1 : 0);
