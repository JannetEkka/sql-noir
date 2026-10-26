// Validated answers, remembered per machine. Checking a case means running its
// reference query on Zetaris two or three times (about 25 s on a laptop), so
// once a case has passed, its answer is kept and the next opening is instant.
// A changed reference query is a different key, so it gets checked again.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Case } from "./cases.ts";
import type { ResultSet } from "./compare.ts";

const keyOf = (c: Case) => `${c.id}:${createHash("sha256").update(c.answerSql).digest("hex").slice(0, 12)}`;

export class AnswerCache {
  private entries: Record<string, ResultSet> = {};

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      try {
        this.entries = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
        this.entries = {};
      }
    }
  }

  get(c: Case): ResultSet | undefined {
    return this.entries[keyOf(c)];
  }

  set(c: Case, answer: ResultSet): void {
    this.entries[keyOf(c)] = answer;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.entries));
    }
  }
}
