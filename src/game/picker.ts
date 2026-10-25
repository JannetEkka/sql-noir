// Chooses the next case: one the player hasn't solved, aimed at the skills
// memory says they struggle with, at a level that grows as they solve more.

import type { Case, Skill } from "./cases.ts";

export function pickNextCase(cases: Case[], solved: string[], weak: Skill[]): { c: Case; reason: string } | null {
  const open = cases.filter((c) => !solved.includes(c.id));
  if (open.length === 0) return null;
  const target = Math.min(5, 1 + Math.floor(solved.length / 2));
  const scored = open.map((c) => {
    const hits = c.skills.filter((s) => weak.includes(s));
    return { c, hits, score: hits.length * 10 - Math.abs(c.level - target) * 3 - (c.level > target + 1 ? 20 : 0) };
  });
  scored.sort((a, b) => b.score - a.score || a.c.level - b.c.level);
  const best = scored[0];
  const reason = best.hits.length
    ? `practises ${best.hits.join(", ")}, which memory says you've struggled with`
    : `level ${best.c.level}, the next step up after ${solved.length} solved case(s)`;
  return { c: best.c, reason };
}
