# SQL Noir (working name)

A detective game that teaches you to query data. The game master gives you a case. You write SQL to crack it. The game runs your query on real data in Zetaris, checks your answer against the data, gives hints, and asks you to explain why your query proves it. It remembers what you got stuck on and builds the next case around it.

Built for the [Open Agent Hackathon 2026](https://hackathon.genai.works/event/open-agent-hackathon-2026), Track 02: The Agent That Can Explain Why. Every verdict comes with evidence from the data, and the player has to explain why too.

**Status: day 1 (Oct 22).** The foundations are in. The game itself is being built.

| Part | State |
|---|---|
| Zetaris REST client and read-only SQL guard | done, tested |
| Meterless Runtime provider (Nightshift) | done, tested against a mock runtime |
| H-MEM memory engine (Meterless) | vendored; conformance suite 13/13 |
| Smoke test and schema recorder for the laptop | done |
| Evidence-based grader | done, tested |
| Case validator and six seed cases | done; seed cases not yet run on live data |
| Case designer and coach (Nemotron) | next |
| Web interface with the evidence panel | next |

## How it fits together

```
player ── web UI ── game master ──► Nightshift (Meterless Runtime) ──► NVIDIA Nemotron
                         │
                         ├── Zetaris (REST) ── NY_TAXI, TPCDS_DB and other sources
                         └── H-MEM ── what this player has mastered and gets wrong
```

- **Zetaris** holds the data every case is built on, and runs both the reference query and the player's query. Grades come from comparing the two result sets, not from the model's opinion.
- **Meterless Nightshift** is the AI provider. Nemotron models from NVIDIA run behind it.
- **H-MEM**, a Meterless Engine, is the player's memory across sessions.

## Setup (Windows)

You need Zetaris running locally in Docker and Meterless Nightshift with an NVIDIA lane, as in the hackathon's participant setup guide, plus Node.js 22 or later.

1. Clone this repo and open it in Cursor.
2. Install the three development tools (no runtime dependencies):
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in your values. The Zetaris API key comes from Management → API Tokens in the Zetaris web UI. The Nightshift URL and token come from Nightshift's Console. The NVIDIA key stays in Nightshift.
4. With Zetaris and Nightshift running:
   ```
   npm run smoke
   ```
   Every line should say PASS.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests, no services needed |
| `npm run typecheck` | TypeScript check |
| `npm run smoke` | Checks Zetaris and Nightshift together and records their replies in `fixtures/recorded` |
| `npm run record:schema` | Records the sample databases' tables, columns and a few rows |
| `npm run validate:cases` | Runs every seed case through the validator against your Zetaris |
| `npm run conformance:hmem` | Runs the H-MEM conformance suite against the vendored engine |

## Pre-existing components

- `vendor/meterless/hmem`: the H-MEM reference and conformance suite from [Meterless/Meterless](https://github.com/Meterless/Meterless), copied unmodified (Apache-2.0). See `vendor/meterless/hmem/VENDORED.md`.

Everything else was written during the hackathon window, starting Oct 22, 2026, 00:00 UTC.

## How AI tools were used

Development is in Cursor, with Claude Code writing much of the code. This section will say which parts came from which tool by submission.
