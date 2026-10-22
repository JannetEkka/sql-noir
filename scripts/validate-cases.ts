// Runs every seed case through the validator against the live Zetaris, and
// saves the outcome in fixtures/recorded/seed-validation.json. Read-only.
//   npm run validate:cases

import { loadEnv, record } from "./env.ts";
import { ZetarisClient, zetarisConfigFromEnv } from "../src/zetaris/client.ts";
import { validateCase } from "../src/game/cases.ts";
import { SEED_CASES } from "../src/game/seed-cases.ts";

loadEnv();
const zetaris = new ZetarisClient(zetarisConfigFromEnv());
const run = async (sql: string) => {
  const result = await zetaris.runSql(sql, { limit: 100 });
  return { columns: result.columns, rows: result.rows };
};

const outcomes = [];
for (const c of SEED_CASES) {
  const v = await validateCase(c, run);
  const failed = v.checks.find((check) => !check.ok);
  console.log(`${v.ok ? "PASS" : "FAIL"}  ${c.id}  ${failed ? `${failed.name}: ${failed.detail}` : `answer: ${JSON.stringify(v.answer?.rows).slice(0, 100)}`}`);
  outcomes.push({ id: c.id, ok: v.ok, checks: v.checks, answer: v.answer });
}
console.log(`\n${outcomes.filter((o) => o.ok).length}/${outcomes.length} seed cases are ready to play.`);
console.log(`Saved ${record("seed-validation", outcomes)}`);
