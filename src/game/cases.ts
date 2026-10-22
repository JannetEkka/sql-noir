// Cases and the validator that stands between the case designer and the
// player: a case is posed only after its reference query has run against the
// live data and given a small, stable, unambiguous answer.

import { compareResults, normalizeValue, type ResultSet } from "./compare.ts";
import { requireReadOnly, SqlRejected } from "../zetaris/sql.ts";

export type Skill =
  | "select"
  | "filter"
  | "sort-limit"
  | "aggregate"
  | "group-by"
  | "having"
  | "join"
  | "date-logic"
  | "subquery"
  | "window"
  | "cross-source";

export interface Case {
  id: string;
  title: string;
  // The briefing the player reads.
  story: string;
  // Exactly what the player has to find.
  question: string;
  // The reference query. Never shown to the player.
  answerSql: string;
  orderMatters: boolean;
  skills: Skill[];
  level: 1 | 2 | 3 | 4 | 5;
  databases: string[];
  hints: string[];
  origin: "seed" | "designer";
}

export type Runner = (sql: string) => Promise<ResultSet>;

export interface CaseCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Validation {
  ok: boolean;
  checks: CaseCheck[];
  answer?: ResultSet;
}

export interface ValidationLimits {
  maxRows: number;
  maxColumns: number;
}

const DEFAULT_LIMITS: ValidationLimits = { maxRows: 25, maxColumns: 6 };

// The last numeric cell of a row: for a "top n" answer, usually the measure
// the rows were ranked by.
function rankingValue(row: unknown[]): string | null {
  for (let i = row.length - 1; i >= 0; i--) {
    const v = normalizeValue(row[i]);
    if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) return v;
  }
  return null;
}

export async function validateCase(c: Case, run: Runner, limits: ValidationLimits = DEFAULT_LIMITS): Promise<Validation> {
  const checks: CaseCheck[] = [];
  const fail = (name: string, detail: string): Validation => {
    checks.push({ name, ok: false, detail });
    return { ok: false, checks };
  };

  let sql: string;
  try {
    sql = requireReadOnly(c.answerSql);
    checks.push({ name: "read-only", ok: true, detail: "the reference query only reads" });
  } catch (err) {
    return fail("read-only", err instanceof SqlRejected ? err.message : String(err));
  }

  if (c.orderMatters && !/\border\s+by\b/i.test(sql)) return fail("ordered", "the case asks for an order but the query has no ORDER BY");

  let first: ResultSet;
  try {
    first = await run(sql);
    checks.push({ name: "runs", ok: true, detail: `${first.rows.length} row(s)` });
  } catch (err) {
    return fail("runs", (err as Error).message);
  }

  if (first.rows.length === 0) return fail("has an answer", "the reference query returns no rows");
  checks.push({ name: "has an answer", ok: true, detail: `${first.rows.length} row(s)` });

  if (first.rows.length > limits.maxRows) return fail("small answer", `${first.rows.length} rows; a case answer should be ${limits.maxRows} or fewer`);
  const columns = first.columns?.length ?? first.rows[0].length;
  if (columns > limits.maxColumns) return fail("small answer", `${columns} columns; a case answer should have ${limits.maxColumns} or fewer`);
  checks.push({ name: "small answer", ok: true, detail: `${first.rows.length} row(s) x ${columns} column(s)` });

  // The same query must give the same answer twice, or grading isn't fair.
  try {
    const second = await run(sql);
    const same = compareResults(first, second, { orderMatters: c.orderMatters });
    if (!same.correct) return fail("stable", `a second run gave a different answer (${same.kind})`);
    checks.push({ name: "stable", ok: true, detail: "two runs agree" });
  } catch (err) {
    return fail("stable", (err as Error).message);
  }

  // "The top 3 stores" has no single answer if the 4th ties with the 3rd.
  const limit = sql.match(/\blimit\s+(\d+)\s*$/i);
  if (limit) {
    const n = Number(limit[1]);
    try {
      const wider = await run(sql.replace(/\blimit\s+\d+\s*$/i, `LIMIT ${n + 1}`));
      const cutoff = wider.rows[n - 1];
      const next = wider.rows[n];
      if (cutoff && next && rankingValue(cutoff) !== null && rankingValue(cutoff) === rankingValue(next)) {
        return fail("unique", `row ${n + 1} ties with row ${n} on ${rankingValue(next)}, so LIMIT ${n} picks one of them arbitrarily`);
      }
      checks.push({ name: "unique", ok: true, detail: `no tie at LIMIT ${n}` });
    } catch (err) {
      return fail("unique", (err as Error).message);
    }
  }

  return { ok: true, checks, answer: first };
}
