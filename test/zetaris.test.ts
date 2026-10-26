import { test } from "node:test";
import assert from "node:assert/strict";
import { ZetarisClient, ZetarisError, extractColumns } from "../src/zetaris/client.ts";
import { prepareStatement, requireReadOnly, splitStatements, SqlRejected } from "../src/zetaris/sql.ts";

// A fetch stand-in that records the request and replies with a fixed body.
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const config = { restUrl: "http://localhost:8888/api/v1.0/", orgId: "1", apiKey: "k" };

test("runSql posts one statement with the headers Zetaris needs", async () => {
  const { impl, calls } = fakeFetch(200, { data: [[1]] });
  const client = new ZetarisClient({ ...config, fetchImpl: impl });
  const result = await client.runSql("SELECT 1 AS one;", { limit: 5 });
  assert.deepEqual(result.rows, [[1]]);
  assert.equal(calls[0].url, "http://localhost:8888/api/v1.0/sql-editor/sqls/run");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer k");
  assert.equal(headers["X-Org-ID"], "1");
  assert.match(headers["X-Request-ID"], /^[0-9a-f-]{36}$/);
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.sql, "SELECT 1 AS one");
  assert.equal(body.source, "SqlEditor");
  assert.equal(body.limit, 5);
  assert.match(body.queryId, /^[0-9a-f-]{36}$/);
});

test("a 401 explains how to get a new key", async () => {
  const client = new ZetarisClient({ ...config, fetchImpl: fakeFetch(401, "nope").impl });
  await assert.rejects(client.runSql("SELECT 1"), (err: ZetarisError) => err.status === 401 && /API Tokens/.test(err.message));
});

test("a query Zetaris can't run gives Spark's message, without the org-id tip", async () => {
  const msg = "[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column or function parameter with name `no_such_column` cannot be resolved. SQLSTATE: 42703; line 1 pos 7";
  const client = new ZetarisClient({ ...config, fetchImpl: fakeFetch(400, { msg }).impl });
  await assert.rejects(client.runSql("SELECT no_such_column FROM TPCDS_DB.reason"), (err: ZetarisError) => {
    assert.match(err.message, /^Zetaris could not run the query: \[UNRESOLVED_COLUMN/);
    assert.doesNotMatch(err.message, /SQLSTATE|ORG_ID/);
    return true;
  });
});

test("an error reported inside a 200 reply is raised", async () => {
  const client = new ZetarisClient({ ...config, fetchImpl: fakeFetch(200, { error: "Table not found: TPCDS_DB.nope" }).impl });
  await assert.rejects(client.runSql("SELECT * FROM TPCDS_DB.nope"), /Table not found/);
});

test("an unreachable Zetaris says how to start it", async () => {
  const impl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const client = new ZetarisClient({ ...config, fetchImpl: impl });
  await assert.rejects(client.runSql("SELECT 1"), /docker compose start/);
});

test("extractColumns finds names in the usual places", () => {
  assert.deepEqual(extractColumns({ columns: ["a", "b"], data: [] }), ["a", "b"]);
  assert.deepEqual(extractColumns({ schema: { fields: [{ name: "x" }] } }), ["x"]);
  assert.equal(extractColumns({ data: [[1]] }), null);
});

test("statements are split outside quotes and comments", () => {
  assert.deepEqual(splitStatements("SELECT ';' AS s; SELECT 2 -- x; y\n;"), ["SELECT ';' AS s", "SELECT 2 \n"].map((s) => s.trim()));
  assert.equal(prepareStatement("  SELECT 1;  "), "SELECT 1");
  assert.throws(() => prepareStatement("SELECT 1; SELECT 2"), SqlRejected);
  assert.throws(() => prepareStatement(" ; "), SqlRejected);
});

test("the read-only guard lets reads through and stops writes", () => {
  for (const sql of ["SELECT 1", "with t as (select 1) select * from t", "SHOW LIGHTNING TABLES TPCDS_DB", "DESCRIBE DATASOURCE TABLE NY_TAXI.taxi_zones", "SELECT 'drop off' AS note"]) {
    assert.doesNotThrow(() => requireReadOnly(sql), sql);
  }
  for (const sql of ["DROP TABLE x", "CREATE LIGHTNING DATABASE X", "WITH t AS (SELECT 1) INSERT INTO y SELECT * FROM t", "CACHE TABLE x", "SELECT 1; DROP TABLE x"]) {
    assert.throws(() => requireReadOnly(sql), SqlRejected, sql);
  }
});
