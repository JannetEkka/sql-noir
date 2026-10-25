// The agent trace: every step an agent takes, in order, so judges and players
// can see how an answer was reached. Kept in memory for the UI and appended
// to a JSON-lines file for the record.

import fs from "node:fs";
import path from "node:path";

export interface TraceEvent {
  at: string;
  agent: string;
  action: string;
  detail: string;
  data?: unknown;
}

export class Trace {
  readonly events: TraceEvent[] = [];

  constructor(private readonly file?: string) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  log(agent: string, action: string, detail: string, data?: unknown): TraceEvent {
    const event: TraceEvent = { at: new Date().toISOString(), agent, action, detail, ...(data === undefined ? {} : { data }) };
    this.events.push(event);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
    return event;
  }

  since(index: number): TraceEvent[] {
    return this.events.slice(index);
  }
}
