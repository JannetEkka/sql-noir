// The player's memory, on the Meterless H-MEM engine. Mistakes and solved
// cases are written as H-MEM records with their source and confidence; before
// coaching, the game recalls what it knows about the player through H-MEM's
// retrieval; tips that helped get positive feedback; and every record's
// history comes from H-MEM's append-only trust ledger.

import { HMEM, type LedgerEntry, type MemoryRecord } from "../../vendor/meterless/hmem/reference/src/index.ts";
import type { Case, Skill } from "./cases.ts";
import type { Trace } from "./trace.ts";

export interface Recall {
  notes: { id: string; content: string; relevance: number }[];
  reason: string;
}

export class PlayerMemory {
  readonly hmem: HMEM;

  constructor(
    private readonly trace: Trace,
    persistDir?: string,
  ) {
    this.hmem = new HMEM({ persistDir, actor: "sql-noir" });
  }

  private active(): MemoryRecord[] {
    return this.hmem.store.all().filter((m: MemoryRecord) => !m.supersededBy);
  }

  rememberMistake(c: Case, skill: Skill, misconception: string): MemoryRecord {
    const record = this.hmem.add({
      content: `Struggled with ${skill} on "${c.title}": ${misconception}`,
      type: "personal",
      tags: ["mistake", skill, c.id],
      confidence: 0.7,
      source: "sql-noir:coach",
      provenance: { origin: "model_response", learnedAt: Date.now(), label: `coach diagnosis on ${c.id}` },
    });
    this.trace.log("memory", "wrote to H-MEM", record.content, { id: record.id });
    return record;
  }

  rememberSolved(c: Case, attempts: number, rating: string): MemoryRecord {
    const record = this.hmem.add({
      content: `Solved "${c.title}" (${c.skills.join(", ")}) in ${attempts} attempt(s); explanation was ${rating}`,
      type: "personal",
      tags: ["solved", c.id, ...c.skills],
      confidence: 0.9,
      source: "sql-noir:grader",
      provenance: { origin: "plan_completion", learnedAt: Date.now(), label: `grader verdict on ${c.id}` },
    });
    this.trace.log("memory", "wrote to H-MEM", record.content, { id: record.id });
    return record;
  }

  // H-MEM retrieval: what the game knows that bears on this case.
  recall(c: Case): Recall {
    const result = this.hmem.query(`mistakes and struggles with ${c.skills.join(" ")} ${c.question}`, { topN: 3, threshold: 0.05 });
    const notes = result.memories
      .filter((m) => m.memory.tags.includes("mistake"))
      .map((m) => ({ id: m.memory.id, content: m.memory.content, relevance: Number(m.relevance.toFixed(3)) }));
    this.trace.log("memory", "recalled from H-MEM", notes.length ? `${notes.length} note(s) about this player` : "nothing relevant yet", { notes, reason: result.trace.retrievalReason });
    return { notes, reason: result.trace.retrievalReason };
  }

  // A recalled note that helped the player solve a case earns confidence.
  markHelpful(ids: string[]): void {
    for (const id of ids) {
      this.hmem.feedback(id, "helpful");
      this.trace.log("memory", "feedback to H-MEM", `note ${id} helped; confidence raised`);
    }
  }

  // Skills ranked by how often they tripped the player, net of cases solved.
  weakSkills(): Skill[] {
    const score = new Map<string, number>();
    for (const m of this.active()) {
      const delta = m.tags.includes("mistake") ? 1 : m.tags.includes("solved") ? -0.5 : 0;
      for (const tag of m.tags) if (tag !== "mistake" && tag !== "solved" && !tag.startsWith("seed-") && !tag.startsWith("case-")) score.set(tag, (score.get(tag) ?? 0) + delta);
    }
    return [...score.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([skill]) => skill as Skill);
  }

  solvedCaseIds(): string[] {
    return this.active().filter((m) => m.tags.includes("solved")).map((m) => m.tags[1]);
  }

  notes(): { id: string; content: string; confidence: number; tags: string[]; source: string }[] {
    return this.active()
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((m) => ({ id: m.id, content: m.content, confidence: Number(m.confidence.toFixed(3)), tags: m.tags, source: m.source }));
  }

  history(id: string): LedgerEntry[] {
    return this.hmem.ledger.history(id);
  }
}
