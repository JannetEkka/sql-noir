// Records the sample databases' tables, their columns and three rows from each,
// so cases can be designed against what Zetaris actually holds. Read-only.
//   npm run record:schema

import { loadEnv, record } from "./env.ts";
import { ZetarisClient, zetarisConfigFromEnv, type QueryResult } from "../src/zetaris/client.ts";

loadEnv();
const zetaris = new ZetarisClient(zetarisConfigFromEnv());
const DATABASES = ["NY_TAXI", "TPCDS_DB"];

// SHOW LIGHTNING TABLES doesn't document its columns. Use a column named like
// "table" if the reply names columns, otherwise the first identifier-like cell
// that isn't the database name.
function tableNames(result: QueryResult, database: string): string[] {
  const index = result.columns?.findIndex((c) => /table/i.test(c)) ?? -1;
  return result.rows
    .map((row) => {
      if (index >= 0) return String(row[index]);
      return row.find((cell) => typeof cell === "string" && /^[A-Za-z_][\w]*$/.test(cell) && cell.toUpperCase() !== database) as string | undefined;
    })
    .filter((name): name is string => !!name);
}

const schema: Record<string, Record<string, { describe?: unknown; sample?: unknown; error?: string }>> = {};
for (const database of DATABASES) {
  const listing = await zetaris.runSql(`SHOW LIGHTNING TABLES ${database}`, { limit: 500 });
  const names = tableNames(listing, database);
  console.log(`${database}: ${names.length} tables`);
  schema[database] = {};
  for (const table of names) {
    const entry: { describe?: unknown; sample?: unknown; error?: string } = {};
    try {
      entry.describe = (await zetaris.runSql(`DESCRIBE DATASOURCE TABLE ${database}.${table}`, { limit: 500 })).raw;
      entry.sample = (await zetaris.runSql(`SELECT * FROM ${database}.${table} LIMIT 3`, { limit: 3 })).raw;
      console.log(`  ok    ${table}`);
    } catch (err) {
      entry.error = (err as Error).message;
      console.log(`  error ${table}: ${entry.error.slice(0, 100)}`);
    }
    schema[database][table] = entry;
  }
}
console.log(`Saved ${record("schema", schema)}`);
