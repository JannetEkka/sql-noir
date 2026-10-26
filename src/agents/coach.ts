// The coach: turns the grader's evidence into a hint, and judges the player's
// "why". A critic checks every hint before the player sees it: a hint that
// gives away the answer (its values or the reference query) goes back to the
// coach to be rewritten once, and if it still leaks, the case's own written
// hint is used instead.

import type { MeterlessProvider } from "../meterless/provider.ts";
import type { Case, Skill } from "../game/cases.ts";
import { describeVerdict, normalizeValue, type ResultSet, type Verdict } from "../game/compare.ts";
import type { Trace } from "../game/trace.ts";
import { askJson } from "./llm.ts";

export const SKILLS: Skill[] = ["select", "filter", "sort-limit", "aggregate", "group-by", "having", "join", "date-logic", "subquery", "window", "cross-source"];

export interface Hint {
  text: string;
  level: 1 | 2 | 3;
  source: "coach" | "case";
  skill: Skill | null;
  misconception: string | null;
}

export interface ExplanationJudgement {
  rating: "solid" | "partial" | "vague";
  feedback: string;
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// What in a hint would give the answer away: a cell of the answer (text of 3+
// characters or a number of 3+ digits), or 28+ characters of the reference query.
export function findLeaks(text: string, c: Case, answer: ResultSet): string[] {
  const leaks: string[] = [];
  const hint = squash(text);
  for (const row of answer.rows) {
    for (const cell of row) {
      const v = normalizeValue(cell).toLowerCase();
      if (v === "\u0000null") continue;
      const isNumber = /^-?\d+(\.\d+)?$/.test(v);
      if ((isNumber && v.replace(/\D/g, "").length >= 3 && new RegExp(`(^|[^\\d.])${v.replace(".", "\\.")}([^\\d]|$)`).test(hint)) || (!isNumber && v.length >= 3 && hint.includes(v))) {
        leaks.push(`gives away the answer value "${normalizeValue(cell)}"`);
      }
    }
  }
  const sql = squash(c.answerSql);
  for (let i = 0; i + 28 <= sql.length; i += 4) {
    if (hint.includes(sql.slice(i, i + 28))) {
      leaks.push("quotes the reference query");
      break;
    }
  }
  return [...new Set(leaks)];
}

function evidenceText(verdict: Verdict): string {
  const e = verdict.evidence;
  return [
    `Verdict: ${verdict.kind}. ${describeVerdict(verdict)}`,
    `Rows expected: ${e.expectedRows}; rows returned: ${e.actualRows}.`,
    e.missing.length ? `Some expected rows the player missed (do not reveal them): ${JSON.stringify(e.missing)}` : "",
    e.extra.length ? `Rows the player returned that should not be there: ${JSON.stringify(e.extra)}` : "",
    `Column matching: ${e.columnMatches.map((m) => `${m.expected} -> ${m.actual === null ? "no match" : m.exact ? m.actual : `${m.actual} (some values differ)`}`).join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export class Coach {
  constructor(
    private readonly provider: MeterlessProvider,
    private readonly trace: Trace,
  ) {}

  async hint(input: { c: Case; verdict: Verdict; answer: ResultSet; playerSql: string; attempt: number; memoryNotes: string[] }): Promise<Hint> {
    const level = Math.min(3, Math.max(1, input.attempt)) as 1 | 2 | 3;
    const style = level === 1 ? "a nudge: point at what to look at, no SQL" : level === 2 ? "name the SQL concept they need, no full query" : "a partial query skeleton with blanks (____) for the key parts";
    const system = [
      "You are Nemo, the player's partner in a hard-boiled 1940s detective agency, in a game that teaches SQL on real data.",
      "Talk like a noir detective: short, wry, addressed to 'kid' or 'detective'. But the SQL lesson must be clear and correct.",
      "Write one hint of at most 3 sentences that moves them toward the answer without giving it away.",
      "Never reveal answer values, and never write the full answer query.",
      `This is hint level ${level}: ${style}.`,
      `Also name the one skill the mistake is about, from: ${SKILLS.join(", ")}; and the misconception in under 12 words.`,
      'Reply with JSON only: {"hint": "...", "skill": "...", "misconception": "..."}',
    ].join("\n");
    const user = [
      `Case: ${input.c.title}. ${input.c.story}`,
      `Question: ${input.c.question}`,
      `Reference query (secret, for your reasoning only): ${input.c.answerSql}`,
      `Player's query: ${input.playerSql}`,
      evidenceText(input.verdict),
      input.memoryNotes.length ? `What memory says about this player:\n- ${input.memoryNotes.join("\n- ")}` : "No memory of this player yet.",
    ].join("\n\n");

    let critique = "";
    for (let round = 1; round <= 2; round++) {
      const reply = await askJson<{ hint?: string; skill?: string; misconception?: string }>(this.provider, this.trace, {
        agent: "coach",
        system,
        user: critique ? `${user}\n\nYour previous hint was rejected by the critic: ${critique}. Write a new one that avoids that.` : user,
      });
      const text = reply?.value?.hint?.trim();
      if (!text) break;
      const leaks = findLeaks(text, input.c, input.answer);
      if (leaks.length === 0) {
        this.trace.log("critic", "approved hint", `level ${level}, no answer values or query in it`);
        const skill = SKILLS.includes(reply!.value.skill as Skill) ? (reply!.value.skill as Skill) : null;
        return { text, level, source: "coach", skill, misconception: reply!.value.misconception?.trim() || null };
      }
      critique = leaks.join("; ");
      this.trace.log("critic", "rejected hint", critique);
    }
    const fallback = input.c.hints[Math.min(level, input.c.hints.length) - 1] ?? "Compare your result with the question again, one condition at a time.";
    this.trace.log("coach", "used the case's own hint", `level ${level}`);
    return { text: fallback, level, source: "case", skill: input.c.skills[0] ?? null, misconception: null };
  }

  async judgeExplanation(input: { c: Case; playerSql: string; explanation: string }): Promise<ExplanationJudgement> {
    const reply = await askJson<{ rating?: string; feedback?: string }>(this.provider, this.trace, {
      agent: "coach",
      system: [
        "You are Nemo, the player's partner in a hard-boiled 1940s detective agency, in a game that teaches SQL. The player cracked the case and explained why their query proves the answer.",
        "Judge the explanation: solid (names how each part of the query answers the question), partial (right idea, missing a step), or vague.",
        "Give one or two sentences of feedback in a wry noir voice; if it isn't solid, end with one follow-up question.",
        'Reply with JSON only: {"rating": "solid|partial|vague", "feedback": "..."}',
      ].join("\n"),
      user: `Question: ${input.c.question}\nPlayer's query: ${input.playerSql}\nPlayer's explanation: ${input.explanation}`,
    });
    const rating = reply?.value?.rating;
    if (rating === "solid" || rating === "partial" || rating === "vague") {
      this.trace.log("coach", "judged the explanation", rating);
      return { rating, feedback: reply!.value.feedback?.trim() || "" };
    }
    // Without the model, a length-and-keyword check is better than nothing.
    const mentions = ["where", "join", "group", "having", "order", "count", "sum", "filter", "limit"].filter((w) => input.explanation.toLowerCase().includes(w)).length;
    const fallback: ExplanationJudgement = mentions >= 2 && input.explanation.length > 60 ? { rating: "partial", feedback: "You named the parts of your query. Say how each one answers the question." } : { rating: "vague", feedback: "Walk through your query: which part answers which part of the question?" };
    this.trace.log("coach", "judged the explanation without the model", fallback.rating);
    return fallback;
  }
}
