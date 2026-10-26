// The case files: the tables a case needs, with their columns (from Zetaris's
// DESCRIBE) and a few sample rows, so the player knows what they can query.
// Read once per table and kept per machine, like checked answers.

import fs from "node:fs";
import path from "node:path";
import type { Case, Runner } from "./cases.ts";
import type { ResultSet } from "./compare.ts";

export interface TableFile {
  table: string;
  columns: { name: string; type: string }[];
  sample: ResultSet | null;
}

// Tables a query names, as DATABASE.table, in the order they appear.
export function tablesIn(sql: string): string[] {
  const found = [...sql.matchAll(/\b(TPCDS_DB|NY_TAXI)\.([A-Za-z_]\w*)/gi)].map((m) => `${m[1].toUpperCase()}.${m[2]}`);
  return [...new Set(found)];
}

export class CaseFiles {
  private cache: Record<string, TableFile> = {};

  constructor(
    private readonly run: Runner,
    private readonly file?: string,
  ) {
    if (file && fs.existsSync(file)) {
      try {
        this.cache = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
        this.cache = {};
      }
    }
  }

  async table(table: string): Promise<TableFile> {
    const cached = this.cache[table];
    if (cached) return cached;
    const described = await this.run(`DESCRIBE DATASOURCE TABLE ${table}`);
    const columns = described.rows
      .map((row) => ({ name: String(row[0] ?? "").trim(), type: String(row[1] ?? "").trim() }))
      .filter((c) => c.name && !c.name.startsWith("#"));
    let sample: ResultSet | null = null;
    try {
      sample = await this.run(`SELECT * FROM ${table} LIMIT 3`);
    } catch {
      sample = null;
    }
    const entry = { table, columns, sample };
    this.cache[table] = entry;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.cache));
    }
    return entry;
  }

  async forCase(c: Case): Promise<TableFile[]> {
    const out: TableFile[] = [];
    for (const t of tablesIn(c.answerSql)) {
      try {
        out.push(await this.table(t));
      } catch {
        out.push({ table: t, columns: [], sample: null });
      }
    }
    return out;
  }
}
