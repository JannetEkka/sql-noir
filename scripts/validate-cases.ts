// Runs every seed case through the validator against the live Zetaris, saves
// the outcome in fixtures/recorded/seed-validation.json, and stores the
// answers of passing cases so the game opens them instantly. Read-only.
//   npm run validate:cases

import { loadEnv, record } from "./env.ts";
import { ZetarisClient, zetarisConfigFromEnv } from "../src/zetaris/client.ts";
import { validateCase } from "../src/game/cases.ts";
import { SEED_CASES } from "../src/game/seed-cases.ts";
import { AnswerCache } from "../src/game/answer-cache.ts";
import { CaseFiles } from "../src/game/files.ts";

loadEnv();
const zetaris = new ZetarisClient(zetarisConfigFromEnv());
const run = async (sql: string) => {
  const result = await zetaris.runSql(sql, { limit: 100 });
  return { columns: result.columns, rows: result.rows };
};

// Cases that pass are remembered, so the game opens them without waiting.
const answers = new AnswerCache(".data/answers.json");
const files = new CaseFiles(run, ".data/tables.json");
const outcomes = [];
for (const c of SEED_CASES) {
  const v = await validateCase(c, run);
  const failed = v.checks.find((check) => !check.ok);
  console.log(`${v.ok ? "PASS" : "FAIL"}  ${c.id}  ${failed ? `${failed.name}: ${failed.detail}` : `answer: ${JSON.stringify(v.answer?.rows).slice(0, 100)}`}`);
  if (v.ok && v.answer) {
    answers.set(c, v.answer);
    await files.forCase(c);
  }
  outcomes.push({ id: c.id, ok: v.ok, checks: v.checks, answer: v.answer });
}
console.log(`\n${outcomes.filter((o) => o.ok).length}/${outcomes.length} seed cases are ready to play.`);
console.log(`Saved ${record("seed-validation", outcomes)}`);
