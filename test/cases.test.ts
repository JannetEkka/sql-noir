import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCase, type Case, type Runner } from "../src/game/cases.ts";
import type { ResultSet } from "../src/game/compare.ts";

const base: Case = {
  id: "t1",
  title: "Test",
  story: "A test case.",
  question: "Find the stores.",
  answerSql: "SELECT s_store_name, cnt FROM t ORDER BY cnt DESC LIMIT 2",
  orderMatters: true,
  skills: ["sort-limit"],
  level: 1,
  databases: ["TPCDS_DB"],
  hints: [],
  origin: "seed",
};

// A runner that answers from a fixed table and remembers what it ran.
function runner(rows: unknown[][], opts: { columns?: string[]; flaky?: boolean } = {}): Runner & { ran: string[] } {
  const ran: string[] = [];
  let calls = 0;
  const fn = (async (sql: string): Promise<ResultSet> => {
    ran.push(sql);
    calls++;
    const limit = Number(sql.match(/LIMIT (\d+)$/i)?.[1] ?? rows.length);
    const out = opts.flaky && calls > 1 ? rows.slice(1) : rows.slice(0, limit);
    return { columns: opts.columns ?? null, rows: out };
  }) as Runner & { ran: string[] };
  fn.ran = ran;
  return fn;
}

test("a good case passes every check", async () => {
  const run = runner([["able", 30], ["bar", 20], ["cally", 10]]);
  const v = await validateCase(base, run);
  assert.equal(v.ok, true, JSON.stringify(v.checks));
  assert.deepEqual(v.checks.map((c) => c.name), ["read-only", "runs", "has an answer", "small answer", "stable", "unique"]);
  assert.deepEqual(v.answer?.rows, [["able", 30], ["bar", 20]]);
  assert.equal(run.ran.at(-1), "SELECT s_store_name, cnt FROM t ORDER BY cnt DESC LIMIT 3");
});

test("a tie at the LIMIT cut-off is refused", async () => {
  const v = await validateCase(base, runner([["able", 30], ["bar", 20], ["cally", 20]]));
  assert.equal(v.ok, false);
  assert.match(v.checks.at(-1)!.detail, /row 3 ties with row 2/);
});

test("a query that writes is refused before it runs", async () => {
  const run = runner([[1]]);
  const v = await validateCase({ ...base, answerSql: "DROP TABLE t" }, run);
  assert.equal(v.ok, false);
  assert.equal(run.ran.length, 0);
});

test("an empty answer is refused", async () => {
  const v = await validateCase(base, runner([]));
  assert.equal(v.checks.at(-1)!.name, "has an answer");
  assert.equal(v.ok, false);
});

test("an answer too big to be a clue is refused", async () => {
  const many = Array.from({ length: 40 }, (_, i) => [`s${i}`, i]);
  const v = await validateCase({ ...base, answerSql: "SELECT a, b FROM t", orderMatters: false }, runner(many));
  assert.equal(v.ok, false);
  assert.match(v.checks.at(-1)!.detail, /40 rows/);
});

test("an answer that changes between runs is refused", async () => {
  const v = await validateCase({ ...base, answerSql: "SELECT a, b FROM t", orderMatters: false }, runner([["a", 1], ["b", 2]], { flaky: true }));
  assert.equal(v.checks.at(-1)!.name, "stable");
  assert.equal(v.ok, false);
});

test("an ordered case without ORDER BY is refused", async () => {
  const v = await validateCase({ ...base, answerSql: "SELECT a FROM t LIMIT 2" }, runner([["a"]]));
  assert.equal(v.checks.at(-1)!.name, "ordered");
});

test("a query error is reported, not thrown", async () => {
  const run = (async () => {
    throw new Error("Table not found: t");
  }) as Runner;
  const v = await validateCase(base, run);
  assert.equal(v.ok, false);
  assert.match(v.checks.at(-1)!.detail, /Table not found/);
});
