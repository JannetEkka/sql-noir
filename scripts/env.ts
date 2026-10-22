// Loads .env from the project folder for the command-line scripts, and writes
// recordings without ever letting a secret into them.

import fs from "node:fs";
import path from "node:path";

export const ROOT = process.cwd();
export const RECORD_DIR = path.join(ROOT, "fixtures", "recorded");

export function loadEnv(): void {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) {
    console.error("No .env file here. Copy .env.example to .env in the project folder and fill in your values.");
    process.exit(1);
  }
  process.loadEnvFile(file);
}

const SECRET_NAMES = ["ZETARIS_API_KEY", "METERLESS_RUNTIME_TOKEN", "ZETARIS_PASSWORD"];

// Saves a recording for building against real reply shapes. Refuses if any
// secret from .env appears anywhere in it.
export function record(name: string, value: unknown): string | null {
  const text = JSON.stringify(value, null, 2);
  for (const secret of SECRET_NAMES.map((n) => process.env[n]).filter((s): s is string => !!s && s.length >= 8)) {
    if (text.includes(secret)) {
      console.error(`  (not saving ${name}: it contains a secret from .env)`);
      return null;
    }
  }
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const file = path.join(RECORD_DIR, `${name}.json`);
  fs.writeFileSync(file, text + "\n");
  return path.relative(ROOT, file);
}
