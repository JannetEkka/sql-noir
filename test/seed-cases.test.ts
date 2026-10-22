import { test } from "node:test";
import assert from "node:assert/strict";
import { SEED_CASES } from "../src/game/seed-cases.ts";
import { requireReadOnly } from "../src/zetaris/sql.ts";

test("seed cases are well formed and only read", () => {
  const ids = new Set<string>();
  for (const c of SEED_CASES) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.doesNotThrow(() => requireReadOnly(c.answerSql), c.id);
    assert.ok(c.story && c.question && c.hints.length > 0, c.id);
    if (c.orderMatters) assert.match(c.answerSql, /order by/i, c.id);
    for (const db of c.databases) assert.match(c.answerSql, new RegExp(`\\b${db}\\.`), c.id);
  }
});
