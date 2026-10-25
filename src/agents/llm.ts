// Helpers for asking the model (Nemotron, through Nightshift) for structured
// answers. Replies can come wrapped in reasoning tags, code fences or prose,
// so the first complete JSON object is pulled out of the text.

import type { MeterlessProvider } from "../meterless/provider.ts";
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
}

// Asks for a JSON object. Returns null (and logs why) if the model can't be
// reached or doesn't produce JSON, so callers can fall back.
export async function askJson<T>(provider: MeterlessProvider, trace: Trace, opts: AskOptions): Promise<{ value: T; model: string | null } | null> {
  try {
    const result = await provider.chat({
      model: opts.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      temperature: 0.4,
    });
    const value = extractJson(result.message.content ?? "") as T;
    trace.log(opts.agent, "model answered", `via ${result.model ?? "Meterless"}`, { model: result.model });
    return { value, model: result.model };
  } catch (err) {
    trace.log(opts.agent, "model unavailable", (err as Error).message);
    return null;
  }
}
