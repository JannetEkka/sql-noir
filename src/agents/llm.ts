// Helpers for asking the model (Nemotron, through Nightshift) for structured
// answers. Replies can come wrapped in reasoning tags, code fences or prose,
// so the first complete JSON object is pulled out of the text.

import type { ChatResult, MeterlessProvider } from "../meterless/provider.ts";
import type { Trace } from "../game/trace.ts";

export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("no JSON object in the reply");
}

export interface AskOptions {
  agent: string;
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
}

export type AskResult<T> = { ok: true; value: T; model: string | null } | { ok: false; reached: boolean; reason: string };

// Asks for a JSON object and says how it went: `reached` is false when
// Nightshift couldn't be reached or refused the call, true when the model
// replied but without a usable JSON object (often a reply cut off at the
// token limit), which is worth asking for again.
export async function askJsonResult<T>(provider: MeterlessProvider, trace: Trace, opts: AskOptions): Promise<AskResult<T>> {
  let result: ChatResult;
  try {
    result = await provider.chat({
      model: opts.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      temperature: 0.4,
      maxTokens: opts.maxTokens,
    });
  } catch (err) {
    trace.log(opts.agent, "model unavailable", (err as Error).message);
    return { ok: false, reached: false, reason: (err as Error).message };
  }
  try {
    const value = extractJson(result.message.content ?? "") as T;
    trace.log(opts.agent, "model answered", `via ${result.model ?? "Meterless"}`, { model: result.model });
    return { ok: true, value, model: result.model };
  } catch {
    const reason = result.finishReason === "length" ? "the reply was cut off before it finished" : "the reply had no JSON object in it";
    trace.log(opts.agent, "model answered without JSON", `via ${result.model ?? "Meterless"}: ${reason}`, { model: result.model });
    return { ok: false, reached: true, reason };
  }
}

// Asks for a JSON object. Returns null (and logs why) if the model can't be
// reached or doesn't produce JSON, so callers can fall back.
export async function askJson<T>(provider: MeterlessProvider, trace: Trace, opts: AskOptions): Promise<{ value: T; model: string | null } | null> {
  const result = await askJsonResult<T>(provider, trace, opts);
  return result.ok ? { value: result.value, model: result.model } : null;
}
