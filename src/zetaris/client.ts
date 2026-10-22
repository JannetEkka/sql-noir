// Zetaris REST client: sends one Lightning SQL statement and returns its rows.
// API shape from Zetaris's getting-started repo (scripts/zetaris_sql.py):
// POST {ZETARIS_REST_URL}/sql-editor/sqls/run with a bearer API key, an
// X-Org-ID header and a fresh UUID X-Request-ID on every call.

import { randomUUID } from "node:crypto";
import { prepareStatement } from "./sql.ts";

export interface ZetarisConfig {
  restUrl: string;
  orgId: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface QueryResult {
  sql: string;
  columns: string[] | null;
  rows: unknown[][];
  elapsedMs: number;
  raw: unknown;
}

export class ZetarisError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly sql?: string,
  ) {
    super(message);
  }
}

export function zetarisConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ZetarisConfig {
  const missing = ["ZETARIS_REST_URL", "ZETARIS_ORG_ID", "ZETARIS_API_KEY"].filter((name) => !env[name]);
  if (missing.length) throw new ZetarisError(`Missing from .env: ${missing.join(", ")}`);
  return { restUrl: env.ZETARIS_REST_URL!, orgId: env.ZETARIS_ORG_ID!, apiKey: env.ZETARIS_API_KEY! };
}

// Zetaris documents `data` (rows as arrays). Column names aren't documented
// for this endpoint, so look in the places APIs usually put them.
export function extractColumns(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const candidates = [r.columns, r.columnNames, r.header, r.headers, r.schema?.fields, r.schema, r.metadata?.columns];
  for (const c of candidates) {
    if (!Array.isArray(c) || c.length === 0) continue;
    const names = c.map((col: any) => (typeof col === "string" ? col : col?.name ?? col?.columnName ?? col?.label));
    if (names.every((n: unknown) => typeof n === "string")) return names;
  }
  return null;
}

export class ZetarisClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ZetarisConfig) {
    this.base = config.restUrl.replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async runSql(sql: string, opts: { limit?: number } = {}): Promise<QueryResult> {
    const statement = prepareStatement(sql);
    const started = Date.now();
    const raw = await this.call("/sql-editor/sqls/run", {
      queryId: randomUUID(),
      sql: statement,
      source: "SqlEditor",
      limit: opts.limit ?? 100,
    }, statement);
    const data = (raw as { data?: unknown })?.data;
    const reported = (raw as Record<string, unknown> | null)?.error ?? (raw as Record<string, unknown> | null)?.errorMessage;
    if ((data === undefined || data === null) && reported) {
      throw new ZetarisError(`Zetaris could not run the query: ${String(typeof reported === "object" ? JSON.stringify(reported) : reported).slice(0, 300)}`, undefined, statement);
    }
    if (data !== undefined && data !== null && !Array.isArray(data)) {
      throw new ZetarisError(`Unexpected Zetaris reply: "data" is not a list`, undefined, statement);
    }
    const rows = ((data as unknown[] | undefined) ?? []).map((row) => (Array.isArray(row) ? row : [row]));
    return { sql: statement, columns: extractColumns(raw), rows, elapsedMs: Date.now() - started, raw };
  }

  datasources(): Promise<unknown> {
    return this.call("/datasource/datasources");
  }

  private async call(path: string, body?: unknown, sql?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "X-Org-ID": this.config.orgId,
          "X-Request-ID": randomUUID(),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
      });
    } catch (err) {
      throw new ZetarisError(
        `Can't reach Zetaris at ${this.base} (${(err as Error).message}). Is it running? In Ubuntu: cd ~/zetaris-platform && docker compose start`,
        undefined,
        sql,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      const hint =
        response.status === 401
          ? " The API key was rejected: create a new one under Management -> API Tokens and update ZETARIS_API_KEY."
          : response.status === 400
            ? " Check ZETARIS_ORG_ID (1 on a local install)."
            : "";
      throw new ZetarisError(`Zetaris returned HTTP ${response.status}: ${text.slice(0, 300)}${hint}`, response.status, sql);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new ZetarisError(`Zetaris replied with something that isn't JSON: ${text.slice(0, 200)}`, response.status, sql);
    }
  }
}
