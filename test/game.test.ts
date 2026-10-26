import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MeterlessProvider } from "../src/meterless/provider.ts";
import { Trace } from "../src/game/trace.ts";
import { PlayerMemory } from "../src/game/memory.ts";
import { Game } from "../src/game/engine.ts";
import { findLeaks } from "../src/agents/coach.ts";
import { extractJson } from "../src/agents/llm.ts";
import { pickNextCase } from "../src/game/picker.ts";
import type { Case, Runner } from "../src/game/cases.ts";
import { startMockRuntime } from "./support/mock-meterless.ts";

const CASE: Case = {
  id: "seed-t",
  title: "The usual excuse",
  story: "Returns are eating the margin.",
  question: "Which reason has the most returned items?",
  answerSql: "SELECT r_reason_desc, SUM(q) AS items FROM TPCDS_DB.r GROUP BY r_reason_desc ORDER BY items DESC LIMIT 1",
  orderMatters: true,
  skills: ["group-by", "sort-limit"],
  level: 2,
  databases: ["TPCDS_DB"],
  hints: ["Group the returns by reason.", "SUM the quantity per reason, then sort."],
  origin: "seed",
};

// Answers the reference query (and its LIMIT 2 tie check) and two player attempts.
const run: Runner = async (sql) => {
  if (/^DESCRIBE/.test(sql)) return { columns: ["col_name", "data_type"], rows: [["r_reason_desc", "string"], ["q", "int"]] };
  if (/LIMIT 3$/.test(sql)) return { columns: ["r_reason_desc", "q"], rows: [["Package was damaged", 3]] };
  if (/LIMIT 2$/.test(sql)) return { columns: ["r_reason_desc", "items"], rows: [["Did not like the warranty", 5120], ["Package was damaged", 4800]] };
  if (sql === CASE.answerSql || /SUM\(sr_return_quantity\)/i.test(sql)) return { columns: ["r_reason_desc", "items"], rows: [["Did not like the warranty", 5120]] };
  if (/COUNT/i.test(sql)) return { columns: ["r_reason_desc", "n"], rows: [["Package was damaged", 990]] };
  throw new Error("cannot resolve column");
};

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sql-noir-"));
}

test("extractJson finds the object inside reasoning and fences", () => {
  assert.deepEqual(extractJson('<think>maybe {x}</think> Sure!\n```json\n{"hint": "a {b}", "n": 1}\n```'), { hint: "a {b}", n: 1 });
  assert.throws(() => extractJson("no json here"));
});

test("the critic catches answer values and the reference query in a hint", () => {
  const answer = { columns: ["r_reason_desc", "items"], rows: [["Did not like the warranty", 5120]] };
  assert.deepEqual(findLeaks("Try grouping by reason first.", CASE, answer), []);
  assert.match(findLeaks("The answer is Did not like the warranty.", CASE, answer)[0], /answer value/);
  assert.match(findLeaks("You should get 5120 items.", CASE, answer)[0], /5120/);
  assert.match(findLeaks(`Use: ${CASE.answerSql}`, CASE, answer).join(), /reference query/);
});

test("the picker aims at weak skills, then levels up", () => {
  const easy = { ...CASE, id: "a", level: 1 as const, skills: ["filter" as const] };
  const joins = { ...CASE, id: "b", level: 2 as const, skills: ["join" as const] };
  assert.equal(pickNextCase([easy, joins], [], [])!.c.id, "a");
  assert.equal(pickNextCase([easy, joins], [], ["join"])!.c.id, "b");
  assert.equal(pickNextCase([easy], ["a"], []), null);
});

test("a full case: wrong answer, critic-checked hint, memory, right answer, explanation", async () => {
  let call = 0;
  const runtime = await startMockRuntime("tok", (body) => {
    call++;
    const system = body.messages[0].content as string;
    if (system.includes("Judge the explanation")) return '{"rating": "solid", "feedback": "You grouped, summed and sorted."}';
    // First hint leaks the answer; the critic should send it back.
    if (call === 1) return '{"hint": "It is Did not like the warranty.", "skill": "aggregate", "misconception": "counts rows instead of summing quantity"}';
    return '<think>careful</think>{"hint": "Counting rows is not counting items. What adds up quantities?", "skill": "aggregate", "misconception": "counts rows instead of summing quantity"}';
  });
  try {
    const trace = new Trace();
    const memory = new PlayerMemory(trace, tmp());
    const provider = new MeterlessProvider({ baseUrl: runtime.baseUrl, token: "tok" });
    const game = new Game({ run, provider, trace, memory, cases: [CASE] });

    assert.equal(await game.next(), true);
    assert.equal(game.view().case!.title, "The usual excuse");
    assert.equal((game.view() as any).reveal, null);

    const refused = await game.submit("DROP TABLE TPCDS_DB.r");
    assert.match(refused.refused!, /won't run here/);

    const wrong = await game.submit("SELECT r_reason_desc, COUNT(*) AS n FROM TPCDS_DB.sr GROUP BY 1 ORDER BY n DESC LIMIT 1");
    assert.equal(wrong.verdict!.correct, false);
    assert.deepEqual(wrong.verdict!.evidence.missing, [], "answer rows stay hidden while the case is open");
    assert.equal(wrong.hintReady, true);
    assert.equal(game.view().hints!.length, 0, "the hint stays sealed until asked for");
    const asked = game.revealHint();
    assert.ok("hint" in asked);
    assert.equal(asked.hint.source, "coach");
    assert.match(asked.hint.text, /Counting rows/);
    assert.ok(trace.events.some((e) => e.agent === "critic" && e.action === "rejected hint"));
    assert.deepEqual(memory.weakSkills(), ["aggregate"]);

    const right = await game.submit("SELECT r_reason_desc, SUM(sr_return_quantity) AS items FROM TPCDS_DB.sr GROUP BY 1 ORDER BY items DESC LIMIT 1");
    assert.equal(right.verdict!.correct, true);
    assert.equal(game.view().phase, "explaining");

    const closed = await game.explain("I grouped returns by reason, summed the quantity and sorted descending, keeping the top one.");
    assert.ok("judgement" in closed && closed.judgement.rating === "solid");
    const view = game.view() as any;
    assert.equal(view.reveal.answerSql, CASE.answerSql);
    // Level 2 case: 200, one wrong attempt -20, one hint -15, solid +50.
    assert.equal(view.award.points, 215);
    assert.equal(view.score.total, 215);
    assert.equal(view.score.rank.name, "Gumshoe");
    assert.deepEqual(memory.solvedCaseIds(), ["seed-t"]);
  } finally {
    await runtime.close();
  }
});

test("without the model, the case's own hints keep the game going", async () => {
  const trace = new Trace();
  const memory = new PlayerMemory(trace, tmp());
  const provider = new MeterlessProvider({ baseUrl: "http://127.0.0.1:9/v1", token: "tok" });
  const game = new Game({ run, provider, trace, memory, cases: [CASE] });
  await game.next();
  await game.submit("SELECT r_reason_desc, COUNT(*) AS n FROM TPCDS_DB.sr GROUP BY 1 ORDER BY n DESC LIMIT 1");
  const asked = game.revealHint();
  assert.ok("hint" in asked);
  assert.equal(asked.hint.source, "case");
  assert.equal(asked.hint.text, "Group the returns by reason.");
});

test("memory recalls past mistakes for a related case, and feedback raises confidence", () => {
  const trace = new Trace();
  const dir = tmp();
  const memory = new PlayerMemory(trace, dir);
  const note = memory.rememberMistake(CASE, "group-by", "filters an aggregate with WHERE instead of HAVING");
  const again = new PlayerMemory(trace, dir); // persisted across sessions
  const recall = again.recall({ ...CASE, id: "seed-other", question: "Which group has the biggest total?" });
  assert.equal(recall.notes[0]?.id, note.id);
  const before = again.notes()[0].confidence;
  again.markHelpful([note.id]);
  assert.ok(again.notes()[0].confidence > before);
  assert.deepEqual(again.history(note.id).map((h) => h.action).slice(0, 1), ["create"]);
});

test("a case checked once opens without running its query again", async () => {
  const { AnswerCache } = await import("../src/game/answer-cache.ts");
  const { CaseFiles } = await import("../src/game/files.ts");
  const answers = new AnswerCache(path.join(tmp(), "answers.json"));
  const filesPath = path.join(tmp(), "tables.json");
  let queries = 0;
  const counting: Runner = async (sql) => {
    queries++;
    return run(sql);
  };
  const provider = new MeterlessProvider({ baseUrl: "http://127.0.0.1:9/v1", token: "tok" });
  const first = new Game({ run: counting, provider, trace: new Trace(), memory: new PlayerMemory(new Trace(), tmp()), cases: [CASE], answers, files: new CaseFiles(counting, filesPath) });
  await first.next();
  const afterFirst = queries;
  assert.ok(afterFirst >= 3, "validation runs the reference query");
  const second = new Game({ run: counting, provider, trace: new Trace(), memory: new PlayerMemory(new Trace(), tmp()), cases: [CASE], answers, files: new CaseFiles(counting, filesPath) });
  await second.next();
  assert.equal(queries, afterFirst);
  const files = (second.view() as any).case.files;
  assert.equal(files[0].table, "TPCDS_DB.r");
  assert.deepEqual(files[0].columns, [{ name: "r_reason_desc", type: "string" }, { name: "q", type: "int" }]);
  assert.equal(files[0].sample.rows.length, 1);
});

test("the case files list the tables a query names", async () => {
  const { tablesIn } = await import("../src/game/files.ts");
  assert.deepEqual(tablesIn("SELECT * FROM TPCDS_DB.store_sales ss JOIN tpcds_db.date_dim d ON 1=1 JOIN TPCDS_DB.store_sales x"), ["TPCDS_DB.store_sales", "TPCDS_DB.date_dim"]);
  assert.deepEqual(tablesIn("SELECT Borough FROM NY_TAXI.taxi_zones"), ["NY_TAXI.taxi_zones"]);
});

test("scoring: levels, mistakes, hints, explanation and streak", async () => {
  const { scoreCase, rankFor } = await import("../src/game/score.ts");
  assert.equal(scoreCase({ level: 1, attempts: 1, hintsShown: 0, rating: "solid", streak: 1 }).points, 150);
  assert.equal(scoreCase({ level: 3, attempts: 4, hintsShown: 2, rating: "vague", streak: 0 }).points, 210);
  assert.equal(scoreCase({ level: 1, attempts: 9, hintsShown: 5, rating: "vague", streak: 0 }).points, 25, "never below a quarter of the case");
  assert.equal(scoreCase({ level: 1, attempts: 1, hintsShown: 0, rating: "partial", streak: 3 }).points, 150);
  assert.deepEqual([rankFor(0).name, rankFor(499).name, rankFor(500).name, rankFor(5000).name], ["Rookie", "Gumshoe", "Sleuth", "Chief Inspector"]);
});
