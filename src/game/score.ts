// Points, rank and streak: what makes solving cases feel like a game. A case
// is worth more at higher levels; wrong attempts and hints cost points; a
// clear "why" earns a bonus; solving without hints builds a streak.

import fs from "node:fs";
import path from "node:path";

export const RANKS = [
  { name: "Rookie", from: 0 },
  { name: "Gumshoe", from: 200 },
  { name: "Sleuth", from: 500 },
  { name: "Inspector", from: 1000 },
  { name: "Chief Inspector", from: 1800 },
] as const;

export const HINT_COST = 15;

export interface Award {
  points: number;
  breakdown: string[];
  rankBefore: string;
  rankAfter: string;
}

export function rankFor(total: number) {
  let index = 0;
  for (let i = 0; i < RANKS.length; i++) if (total >= RANKS[i].from) index = i;
  const next = RANKS[index + 1];
  return { name: RANKS[index].name, next: next?.name ?? null, toNext: next ? next.from - total : 0, progress: next ? (total - RANKS[index].from) / (next.from - RANKS[index].from) : 1 };
}

export function scoreCase(input: { level: number; attempts: number; hintsShown: number; rating: "solid" | "partial" | "vague"; streak: number }): { points: number; breakdown: string[] } {
  const base = 100 * input.level;
  const breakdown = [`case worth ${base}`];
  let points = base;
  const wrong = Math.max(0, input.attempts - 1);
  if (wrong) {
    points -= 20 * wrong;
    breakdown.push(`-${20 * wrong} for ${wrong} wrong attempt(s)`);
  }
  if (input.hintsShown) {
    points -= HINT_COST * input.hintsShown;
    breakdown.push(`-${HINT_COST * input.hintsShown} for ${input.hintsShown} hint(s)`);
  }
  points = Math.max(Math.round(base * 0.25), points);
  const bonus = input.rating === "solid" ? 50 : input.rating === "partial" ? 20 : 0;
  if (bonus) {
    points += bonus;
    breakdown.push(`+${bonus} for a ${input.rating} explanation`);
  }
  if (input.streak > 1) {
    points += 10 * input.streak;
    breakdown.push(`+${10 * input.streak} for a streak of ${input.streak}`);
  }
  return { points, breakdown };
}

export class Scoreboard {
  total = 0;
  streak = 0;
  solved = 0;

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) Object.assign(this, JSON.parse(fs.readFileSync(file, "utf-8")));
  }

  award(input: { level: number; attempts: number; hintsShown: number; rating: "solid" | "partial" | "vague" }): Award {
    const rankBefore = rankFor(this.total).name;
    this.streak = input.hintsShown === 0 ? this.streak + 1 : 0;
    const { points, breakdown } = scoreCase({ ...input, streak: this.streak });
    this.total += points;
    this.solved++;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ total: this.total, streak: this.streak, solved: this.solved }));
    }
    return { points, breakdown, rankBefore, rankAfter: rankFor(this.total).name };
  }

  view() {
    return { total: this.total, streak: this.streak, solved: this.solved, rank: rankFor(this.total) };
  }
}
