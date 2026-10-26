// SQL Noir's web server: serves the page and a small JSON API over the game.
// Node's built-in http module only, so there's nothing extra to install.
//   npm start   then open http://localhost:4321

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZetarisClient, zetarisConfigFromEnv } from "./zetaris/client.ts";
import { MeterlessProvider, meterlessConfigFromEnv } from "./meterless/provider.ts";
import { Trace } from "./game/trace.ts";
import { PlayerMemory } from "./game/memory.ts";
import { Game, schemaText } from "./game/engine.ts";
import { Scoreboard } from "./game/score.ts";
import { AnswerCache } from "./game/answer-cache.ts";
import { CaseFiles } from "./game/files.ts";
import type { Runner, Skill } from "./game/cases.ts";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export interface AppDeps {
  run: Runner;
  provider: MeterlessProvider;
  trace: Trace;
  memory: PlayerMemory;
  game: Game;
  checkZetaris: () => Promise<boolean>;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function createApp(deps: AppDeps): http.Server {
  const { game, memory, trace, provider } = deps;
  const state = () => ({ game: game.view(), memory: memory.notes(), weakSkills: memory.weakSkills(), caseCount: game.cases.length });
  let busy = false;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^[/\\]+/, ""));
        if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, { error: "not found" });
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
        return void fs.createReadStream(file).pipe(res);
      }
      if (req.method === "GET" && url.pathname === "/api/state") return send(200, state());
      if (req.method === "GET" && url.pathname === "/api/trace") return send(200, { events: trace.since(Number(url.searchParams.get("since") ?? 0)) });
      if (req.method === "GET" && url.pathname === "/api/status") {
        const [zetaris, runtime] = await Promise.all([deps.checkZetaris(), provider.status()]);
        return send(200, { zetaris, meterless: runtime.status, model: provider.model });
      }
      const history = url.pathname.match(/^\/api\/memory\/([\w-]+)\/history$/);
      if (req.method === "GET" && history) return send(200, { history: memory.history(history[1]) });

      if (req.method === "POST") {
        // One agent action at a time: the laptop runs Zetaris and the model calls.
        if (busy) return send(409, { error: "Still working on the last step." });
        busy = true;
        try {
          const body = await readJson(req);
          if (url.pathname === "/api/next") {
            const ok = await game.next();
            return send(200, { ok, ...state() });
          }
          if (url.pathname === "/api/query") return send(200, { ...(await game.submit(String(body.sql ?? ""))), ...state() });
          if (url.pathname === "/api/hint") return send(200, { ...game.revealHint(), ...state() });
          if (url.pathname === "/api/explain") return send(200, { ...(await game.explain(String(body.text ?? ""))), ...state() });
          if (url.pathname === "/api/design") return send(200, { ...(await game.design(body.skill as Skill | undefined)), ...state() });
        } finally {
          busy = false;
        }
      }
      send(404, { error: "not found" });
    } catch (err) {
      trace.log("server", "error", (err as Error).message);
      send(500, { error: (err as Error).message });
    }
  });
}

// Started directly (npm start), not imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const zetaris = new ZetarisClient(zetarisConfigFromEnv());
  const provider = new MeterlessProvider(meterlessConfigFromEnv());
  const trace = new Trace(path.join(".data", "trace.jsonl"));
  const memory = new PlayerMemory(trace, path.join(".data", "memory"));
  const run: Runner = async (sql) => {
    const r = await zetaris.runSql(sql, { limit: 200 });
    return { columns: r.columns, rows: r.rows };
  };
  const game = new Game({
    run,
    provider,
    trace,
    memory,
    schema: schemaText(),
    score: new Scoreboard(path.join(".data", "score.json")),
    answers: new AnswerCache(path.join(".data", "answers.json")),
    files: new CaseFiles(run, path.join(".data", "tables.json")),
  });
  const checkZetaris = async () => {
    try {
      await zetaris.runSql("SELECT 1");
      return true;
    } catch {
      return false;
    }
  };
  const port = Number(process.env.PORT ?? 4321);
  createApp({ run, provider, trace, memory, game, checkZetaris }).listen(port, "127.0.0.1", () => {
    console.log(`SQL Noir is running: open http://localhost:${port}`);
    trace.log("server", "started", `http://localhost:${port}, model ${provider.model}`);
  });
}
