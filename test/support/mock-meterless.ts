// A small stand-in for Nightshift's Meterless Runtime, for tests. It checks the
// token and headers the provider contract requires, lists routes, and answers
// chat with plain text, or with a tool call when tools are offered.

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRuntime {
  baseUrl: string;
  requests: { path: string; headers: http.IncomingHttpHeaders; body: any }[];
  failNext429: number;
  close(): Promise<void>;
}

// `reply`, when given, decides the assistant's text for each chat request.
export async function startMockRuntime(token: string, reply?: (body: any) => string): Promise<MockRuntime> {
  const state = { failNext429: 0 };
  const requests: MockRuntime["requests"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url === "/healthz") return send(200, { ok: true });
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
      if (req.url === "/v1/models") {
        return send(200, { data: [{ id: "meterless/auto" }, { id: "meterless/fast" }, { id: "local-runtime/llama-3.2-3b" }] });
      }
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        if (state.failNext429 > 0) {
          state.failNext429--;
          return send(429, { error: "rate limited" });
        }
        const model = "nvidia/nemotron-3.5-lightning-30b-a3b";
        if (body?.tools?.length) {
          const tool = body.tools[0].function.name;
          return send(200, {
            model,
            choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: '{"sql":"SELECT 1"}' } }] } }],
          });
        }
        return send(200, { model, choices: [{ message: { role: "assistant", content: reply ? reply(body) : "The connection works." } }] });
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    get failNext429() {
      return state.failNext429;
    },
    set failNext429(n: number) {
      state.failNext429 = n;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
