// The case designer: Nemotron drafts a new case for a skill the player needs,
// and the validator runs its reference query against Zetaris. A draft that
// fails a check goes back to the designer with the reason, up to three times.
// A case reaches the player only after it passes.

import type { MeterlessProvider } from "../meterless/provider.ts";
import { validateCase, type Case, type Runner, type Skill, type Validation } from "../game/cases.ts";
import type { Trace } from "../game/trace.ts";
import { askJson } from "./llm.ts";
import { SKILLS } from "./coach.ts";

export interface DesignAttempt {
  draft: Partial<Case> | null;
  validation: Validation | null;
  problem: string | null;
}

function toCase(draft: any, skill: Skill, level: number): Case | null {
  if (!draft || typeof draft !== "object") return null;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (!text(draft.title) || !text(draft.story) || !text(draft.question) || !text(draft.answerSql)) return null;
  const skills = (Array.isArray(draft.skills) ? draft.skills : []).filter((s: unknown) => SKILLS.includes(s as Skill)) as Skill[];
  const databases = (text(draft.answerSql).match(/\b(TPCDS_DB|NY_TAXI)\./gi) ?? []).map((d) => d.slice(0, -1).toUpperCase());
  return {
    id: `case-${Date.now().toString(36)}`,
    title: text(draft.title),
    story: text(draft.story),
    question: text(draft.question),
    answerSql: text(draft.answerSql),
    orderMatters: draft.orderMatters === true,
    skills: skills.includes(skill) ? skills : [skill, ...skills],
    level: Math.min(5, Math.max(1, Number(draft.level) || level)) as Case["level"],
    databases: [...new Set(databases)],
    hints: (Array.isArray(draft.hints) ? draft.hints : []).map(text).filter(Boolean).slice(0, 3),
    origin: "designer",
  };
}

export async function designCase(input: {
  provider: MeterlessProvider;
  trace: Trace;
  run: Runner;
  schema: string;
  skill: Skill;
  level: number;
  avoidTitles: string[];
  maxTries?: number;
}): Promise<{ c: Case | null; attempts: DesignAttempt[] }> {
  const attempts: DesignAttempt[] = [];
  const system = [
    "You design cases for a SQL detective game played on real data in Zetaris (Spark-style SQL).",
    "A case is a short noir-flavoured story, a precise question, and the reference query that answers it.",
    "Rules for the reference query: one read-only SELECT; qualify every table as DATABASE.table; the answer must be small (at most 10 rows, at most 4 columns);",
    "if you use ORDER BY ... LIMIT, make sure the cut-off can't tie; set orderMatters true only if the question asks for an order.",
    "Write two hints that teach without giving the answer.",
    'Reply with JSON only: {"title","story","question","answerSql","orderMatters","skills":[...],"level","hints":[...]}',
  ].join("\n");
  let feedback = "";
  for (let i = 1; i <= (input.maxTries ?? 3); i++) {
    input.trace.log("designer", "drafting a case", `skill ${input.skill}, level ${input.level}, try ${i}`);
    const reply = await askJson<Record<string, unknown>>(input.provider, input.trace, {
      agent: "designer",
      system,
      user: [
        `Tables available:\n${input.schema}`,
        `The case must practise: ${input.skill} (level ${input.level} of 5). Skills to choose from: ${SKILLS.join(", ")}.`,
        input.avoidTitles.length ? `Don't repeat these cases: ${input.avoidTitles.join("; ")}` : "",
        feedback ? `Your last draft failed validation: ${feedback}. Fix that.` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    const c = toCase(reply?.value, input.skill, input.level);
    if (!c) {
      const problem = reply ? "the draft was missing a title, story, question or query" : "the model could not be reached";
      attempts.push({ draft: (reply?.value as Partial<Case>) ?? null, validation: null, problem });
      input.trace.log("validator", "rejected draft", problem);
      if (!reply) break;
      feedback = problem;
      continue;
    }
    const validation = await validateCase(c, input.run);
    const failed = validation.checks.find((check) => !check.ok);
    attempts.push({ draft: c, validation, problem: failed ? `${failed.name}: ${failed.detail}` : null });
    if (validation.ok) {
      input.trace.log("validator", "approved case", `"${c.title}": ${validation.checks.map((check) => check.name).join(", ")} all pass`);
      return { c, attempts };
    }
    feedback = `${failed!.name}: ${failed!.detail}`;
    input.trace.log("validator", "rejected draft", feedback);
  }
  return { c: null, attempts };
}
