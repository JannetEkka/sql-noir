// Meterless Runtime provider. Follows the "Add Meterless as a provider" Power
// prompt (Meterless Runtime 1.4, provider contract v4) from
// https://meterless.ai/engines.html: OpenAI-compatible, a real bearer token on
// every call, meterless-app on every call, meterless-scope: user on chat, and
// GET /v1/models (not /healthz) decides whether the runtime is usable.

export const PROVIDER_ID = "meterless";
export const PROVIDER_NAME = "Meterless Runtime";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8088/v1";
export const APP_ID = "sql-noir";
const CHAT_TIMEOUT_MS = 180_000;
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

export type RuntimeStatus = "online" | "unauthorized" | "offline";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  tools?: ToolDefinition[];
  temperature?: number;
}

export interface ChatResult {
  message: ChatMessage;
  model: string | null;
  raw: unknown;
}

export class MeterlessError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

// Accepts a pasted URL with or without a scheme, ending in /v1,
// /v1/chat/completions, /v1/models or /healthz, and returns <origin>/v1.
export function normalizeBaseUrl(input: string): string {
  let text = input.trim();
  if (!text) return DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  const url = new URL(text);
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(chat\/completions|models|healthz)$/i, "");
  path = path.replace(/(\/v1)+$/i, "");
  return `${url.origin}${path}/v1`;
}

// A connect link (http://<host>:<port>/connect#k=<key>) carries both the base
// URL and the token. Never log the result.
export function parseConnectLink(link: string): { baseUrl: string; token: string } | null {
  try {
    const url = new URL(link.trim());
    if (!/\/connect\/?$/.test(url.pathname)) return null;
    const token = new URLSearchParams(url.hash.replace(/^#/, "")).get("k");
    if (!token) return null;
    return { baseUrl: `${url.origin}/v1`, token };
  } catch {
    return null;
  }
}

export interface MeterlessConfig {
  baseUrl?: string;
  token: string;
  model?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function meterlessConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MeterlessConfig {
  if (!env.METERLESS_RUNTIME_TOKEN) {
    throw new MeterlessError("Missing from .env: METERLESS_RUNTIME_TOKEN (copy it from Nightshift's Console)");
  }
  return {
    baseUrl: env.METERLESS_BASE_URL || DEFAULT_BASE_URL,
    token: env.METERLESS_RUNTIME_TOKEN,
    model: env.METERLESS_MODEL || "meterless/auto",
  };
}

// The text of a reply, whether content came back as a string or as parts.
export function messageText(message: ChatMessage | { content?: unknown }): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === "string" ? part : part?.type === "text" ? part.text ?? "" : ""))
      .join("");
  }
  return "";
}

export class MeterlessProvider {
  readonly baseUrl: string;
  readonly model: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: MeterlessConfig) {
    if (!config.token || config.token === "rt-local") {
      throw new MeterlessError("A real Nightshift runtime token is needed; copy it from Nightshift's Console.");
    }
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.token = config.token;
    this.model = config.model ?? "meterless/auto";
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private headers(chat: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "meterless-app": APP_ID,
      ...(chat ? { "meterless-scope": "user", "Content-Type": "application/json" } : {}),
    };
  }

  // GET /v1/models decides: 401/403 is unauthorized, 200 listing meterless/*
  // routes is online, anything else (including no answer) is offline.
  async status(): Promise<{ status: RuntimeStatus; models: string[] }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: this.headers(false),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { status: "offline", models: [] };
    }
    if (response.status === 401 || response.status === 403) return { status: "unauthorized", models: [] };
    if (!response.ok) return { status: "offline", models: [] };
    const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    const models = (body?.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    return { status: models.some((id) => id.startsWith("meterless/")) ? "online" : "offline", models };
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const body = JSON.stringify({
      model: request.model ?? this.model,
      messages: request.messages,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    });
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(true),
          body,
          signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
        });
      } catch (err) {
        throw new MeterlessError(`Can't reach Nightshift at ${this.baseUrl} (${(err as Error).message}). Is Nightshift running?`);
      }
      if (response.status === 429 && attempt < RETRY_DELAYS_MS.length) {
        await this.sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      const text = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new MeterlessError("Nightshift rejected the runtime token. Copy it again from Nightshift's Console.", response.status);
      }
      if (!response.ok) throw new MeterlessError(`Nightshift returned HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
      let raw: any;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new MeterlessError(`Nightshift replied with something that isn't JSON: ${text.slice(0, 200)}`);
      }
      const choice = raw?.choices?.[0]?.message;
      if (!choice) throw new MeterlessError("Nightshift's reply had no message in it.");
      const message: ChatMessage = {
        role: "assistant",
        content: messageText(choice) || null,
        ...(Array.isArray(choice.tool_calls) && choice.tool_calls.length ? { tool_calls: choice.tool_calls } : {}),
      };
      return { message, model: typeof raw.model === "string" ? raw.model : null, raw };
    }
  }
}

// Finds a running runtime on the usual ports. Returns the first base URL that
// answers as online or unauthorized.
export async function autoDetect(token: string, fetchImpl: typeof fetch = fetch): Promise<{ baseUrl: string; status: RuntimeStatus } | null> {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    for (const port of [8088, 8090, 8787, 11434]) {
      const provider = new MeterlessProvider({ baseUrl: `http://${host}:${port}/v1`, token, fetchImpl });
      const { status } = await provider.status();
      if (status !== "offline") return { baseUrl: provider.baseUrl, status };
    }
  }
  return null;
}
