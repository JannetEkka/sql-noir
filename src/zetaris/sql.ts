// Statement handling for Zetaris Lightning SQL. Zetaris takes one statement
// per call with no trailing semicolon, and the game only ever reads data, so
// anything that isn't a read is refused before it reaches Zetaris.

const READ_KEYWORDS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN"]);
const WRITE_WORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|CREATE|ALTER|TRUNCATE|CACHE|UNCACHE|REGISTER|GRANT|REVOKE|COMPILE|ACTIVATE|MATERIALIZE|REMOVE)\b/i;

export class SqlRejected extends Error {}

// Splits on semicolons that sit outside quotes, backticks and comments.
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end - 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

// One statement, comments and trailing semicolons removed, ready to send.
export function prepareStatement(sql: string): string {
  const statements = splitStatements(sql);
  if (statements.length === 0) throw new SqlRejected("The query is empty.");
  if (statements.length > 1) {
    throw new SqlRejected(`Send one statement at a time; this has ${statements.length}.`);
  }
  return statements[0];
}

// The statement, prepared, if it only reads; otherwise SqlRejected.
export function requireReadOnly(sql: string): string {
  const statement = prepareStatement(sql);
  const keyword = statement.match(/^[(\s]*([A-Za-z]+)/)?.[1]?.toUpperCase() ?? "";
  if (!READ_KEYWORDS.has(keyword)) {
    throw new SqlRejected(`Only queries that read data can run here; "${keyword || statement.slice(0, 20)}" changes something.`);
  }
  // A read can still hide a write, e.g. WITH ... INSERT. Quoted text is
  // ignored so a string like 'drop off' doesn't trip the check.
  const unquoted = statement.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
  const write = unquoted.match(WRITE_WORDS)?.[1];
  if (write) throw new SqlRejected(`Only queries that read data can run here; it contains ${write.toUpperCase()}.`);
  return statement;
}
