// The game master: picks the next case, checks it against the data, runs the
// player's queries, grades them by evidence, asks the coach for hints, keeps
// the player's memory, and asks the designer for new cases. Every step goes
// to the trace.

import fs from "node:fs";
import type { MeterlessProvider } from "../meterless/provider.ts";
import { requireReadOnly, SqlRejected } from "../zetaris/sql.ts";
import { validateCase, type Case, type Runner, type Skill } from "./cases.ts";
import { compareResults, describeVerdict, type ResultSet, type Verdict } from "./compare.ts";
import { pickNextCase } from "./picker.ts";
import type { PlayerMemory, Recall } from "./memory.ts";
import type { Trace } from "./trace.ts";
import { Coach, type ExplanationJudgement, type Hint } from "../agents/coach.ts";
import { designCase } from "../agents/designer.ts";
import { SEED_CASES } from "./seed-cases.ts";

type Phase = "investigating" | "explaining" | "closed";

interface Current {
  c: Case;
  answer: ResultSet;
  attempts: number;
  hints: Hint[];
  recall: Recall;
  phase: Phase;
  lastSql: string | null;
  pickReason: string;
  judgement: ExplanationJudgement | null;
}

export interface SubmitResult {
  refused?: string;
  error?: string;
  result?: ResultSet;
  verdict?: Verdict;
  message?: string;
  hint?: Hint;
}

const SHOW_ROWS = 50;

// The evidence the player may see while the case is open: their own extra
// rows and the column matches, but never the answer rows they missed.
function redact(verdict: Verdict): Verdict {
  return { ...verdict, evidence: { ...verdict.evidence, missing: [] } };
}

// A short description of the tables for the case designer, from the schema
// recording if there is one, otherwise the standard columns the seeds use.
export function schemaText(file = "fixtures/recorded/schema.json"): string {
  if (fs.existsSync(file)) {
    try {
      const schema = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, Record<string, { describe?: { data?: unknown[][] } }>>;
      const lines: string[] = [];
      for (const [db, tables] of Object.entries(schema)) {
        for (const [table, info] of Object.entries(tables)) {
          const cols = (info.describe?.data ?? []).map((row) => `${row[0]} ${row[1] ?? ""}`.trim()).filter((c) => !c.startsWith("#")).slice(0, 18);
          if (cols.length) lines.push(`${db}.${table}(${cols.join(", ")})`);
        }
      }
      if (lines.length) return lines.join("\n");
    } catch {
      // fall through to the standard columns
    }
  }
  return [
    "TPCDS_DB.store(s_store_sk, s_store_id, s_store_name, s_city, s_state, s_floor_space, s_number_employees)",
    "TPCDS_DB.store_sales(ss_sold_date_sk, ss_item_sk, ss_customer_sk, ss_store_sk, ss_promo_sk, ss_ticket_number, ss_quantity, ss_sales_price, ss_net_paid, ss_net_profit)",
    "TPCDS_DB.store_returns(sr_returned_date_sk, sr_item_sk, sr_customer_sk, sr_store_sk, sr_reason_sk, sr_ticket_number, sr_return_quantity, sr_return_amt, sr_net_loss)",
    "TPCDS_DB.reason(r_reason_sk, r_reason_id, r_reason_desc)",
    "TPCDS_DB.item(i_item_sk, i_item_id, i_product_name, i_category, i_class, i_brand, i_current_price)",
    "TPCDS_DB.date_dim(d_date_sk, d_date, d_year, d_moy, d_dom, d_day_name, d_qoy, d_holiday, d_weekend)",
    "TPCDS_DB.promotion(p_promo_sk, p_promo_name, p_channel_email, p_channel_tv, p_cost)",
    "NY_TAXI.taxi_zones(LocationID, Borough, Zone, service_zone)",
  ].join("\n");
}

export class Game {
  readonly cases: Case[];
  private readonly coach: Coach;
  private readonly broken = new Set<string>();
  current: Current | null = null;

  constructor(
    private readonly deps: { run: Runner; provider: MeterlessProvider; trace: Trace; memory: PlayerMemory; cases?: Case[]; schema?: string },
  ) {
    this.cases = [...(deps.cases ?? SEED_CASES)];
    this.coach = new Coach(deps.provider, deps.trace);
  }

  private async open(c: Case, pickReason: string): Promise<boolean> {
    const { trace } = this.deps;
    trace.log("game master", "checking the case against the data", `"${c.title}"`);
    const validation = await validateCase(c, this.deps.run);
    const failed = validation.checks.find((check) => !check.ok);
    if (!validation.ok) {
      this.broken.add(c.id);
      trace.log("validator", "set the case aside", `"${c.title}": ${failed?.name}: ${failed?.detail}`);
      return false;
    }
    trace.log("validator", "case is fair", `"${c.title}": ${validation.checks.map((check) => check.name).join(", ")} all pass`);
    const recall = this.deps.memory.recall(c);
    this.current = { c, answer: validation.answer!, attempts: 0, hints: [], recall, phase: "investigating", lastSql: null, pickReason, judgement: null };
    return true;
  }

  async next(): Promise<boolean> {
    const { memory, trace } = this.deps;
    for (;;) {
      const solved = [...memory.solvedCaseIds(), ...this.broken];
      const weak = memory.weakSkills();
      const pick = pickNextCase(this.cases, solved, weak);
      if (!pick) {
        trace.log("game master", "no cases left", "ask the designer for a new one");
        this.current = null;
        return false;
      }
      trace.log("game master", "picked the next case", `"${pick.c.title}": ${pick.reason}`);
      if (await this.open(pick.c, pick.reason)) return true;
    }
  }

  async submit(sql: string): Promise<SubmitResult> {
    const cur = this.current;
    const { trace } = this.deps;
    if (!cur || cur.phase !== "investigating") return { error: "There's no open case to work on." };
    let statement: string;
    try {
      statement = requireReadOnly(sql);
    } catch (err) {
      const reason = err instanceof SqlRejected ? err.message : String(err);
      trace.log("guard", "refused a query", reason);
      return { refused: `That won't run here, detective. ${reason}` };
    }
    cur.lastSql = statement;
    let result: ResultSet;
    try {
      trace.log("game master", "ran the player's query on Zetaris", statement);
      result = await this.deps.run(statement);
    } catch (err) {
      trace.log("zetaris", "query failed", (err as Error).message);
      return { error: (err as Error).message };
    }
    const verdict = compareResults(cur.answer, result, { orderMatters: cur.c.orderMatters });
    trace.log("grader", `verdict: ${verdict.kind}`, describeVerdict(verdict), { expectedRows: verdict.evidence.expectedRows, actualRows: verdict.evidence.actualRows });
    const shown = { columns: result.columns, rows: result.rows.slice(0, SHOW_ROWS) };
    if (verdict.correct) {
      cur.attempts++;
      cur.phase = "explaining";
      return { result: shown, verdict, message: `${describeVerdict(verdict)} Now tell me: why does your query prove it?` };
    }
    cur.attempts++;
    const hint = await this.coach.hint({ c: cur.c, verdict, answer: cur.answer, playerSql: statement, attempt: cur.attempts, memoryNotes: cur.recall.notes.map((n) => n.content) });
    cur.hints.push(hint);
    if (hint.skill) this.deps.memory.rememberMistake(cur.c, hint.skill, hint.misconception ?? describeVerdict(verdict));
    return { result: shown, verdict: redact(verdict), message: describeVerdict(verdict), hint };
  }

  async explain(text: string): Promise<{ judgement: ExplanationJudgement; answer: ResultSet; answerSql: string } | { error: string }> {
    const cur = this.current;
    if (!cur || cur.phase !== "explaining") return { error: "Solve the case first, then explain it." };
    const judgement = await this.coach.judgeExplanation({ c: cur.c, playerSql: cur.lastSql ?? "", explanation: text });
    cur.judgement = judgement;
    cur.phase = "closed";
    this.deps.memory.rememberSolved(cur.c, cur.attempts, judgement.rating);
    if (cur.recall.notes.length) this.deps.memory.markHelpful(cur.recall.notes.map((n) => n.id));
    this.deps.trace.log("game master", "case closed", `"${cur.c.title}" in ${cur.attempts} attempt(s), explanation ${judgement.rating}`);
    return { judgement, answer: cur.answer, answerSql: cur.c.answerSql };
  }

  async design(skill?: Skill): Promise<{ ok: boolean; problem?: string }> {
    const weak = this.deps.memory.weakSkills();
    const target = skill ?? weak[0] ?? "join";
    const level = Math.min(5, 1 + Math.floor(this.deps.memory.solvedCaseIds().length / 2));
    const { c, attempts } = await designCase({
      provider: this.deps.provider,
      trace: this.deps.trace,
      run: this.deps.run,
      schema: this.deps.schema ?? schemaText(),
      skill: target,
      level,
      avoidTitles: this.cases.map((x) => x.title),
    });
    if (!c) return { ok: false, problem: attempts.at(-1)?.problem ?? "no draft" };
    this.cases.push(c);
    return { ok: await this.open(c, `designed just now to practise ${target}`) };
  }

  // What the browser may see. The reference query and answer stay hidden
  // until the case is closed.
  view() {
    const cur = this.current;
    if (!cur) return { case: null };
    const closed = cur.phase === "closed";
    return {
      case: { id: cur.c.id, title: cur.c.title, story: cur.c.story, question: cur.c.question, level: cur.c.level, skills: cur.c.skills, origin: cur.c.origin, orderMatters: cur.c.orderMatters },
      phase: cur.phase,
      attempts: cur.attempts,
      hints: cur.hints,
      pickReason: cur.pickReason,
      recalled: cur.recall.notes,
      judgement: cur.judgement,
      reveal: closed ? { answerSql: cur.c.answerSql, answer: cur.answer } : null,
    };
  }
}
