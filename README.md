# SQL Noir (working name)

A detective game that teaches you to query data. The game master gives you a case. You write SQL to crack it. The game runs your query on real data in **Zetaris**, checks your answer against the data, and when you're wrong it shows you the evidence: the rows you shouldn't have, the rows you're missing, the column that doesn't line up. A coach running on **NVIDIA Nemotron** (through **Meterless Nightshift**) turns that evidence into a hint, and a critic makes sure the hint never gives the answer away. Once you've cracked the case, you have to explain why your query proves it. The game remembers what you got stuck on, using the **Meterless H-MEM** engine, and aims the next case at it.

Built for the [Open Agent Hackathon 2026](https://hackathon.genai.works/event/open-agent-hackathon-2026), **Track 02: The Agent That Can Explain Why.** No verdict comes from the model's opinion. Every verdict is a comparison of two result sets on live data, and it comes with the rows that prove it.

## How it works

```
                 ┌──────────── trace: every step, in order ────────────┐
player ── page ── game master ── picks a case ◄── H-MEM: what you get wrong
                      │
                      ├── validator ── runs the case's reference query on Zetaris:
                      │                read-only? any rows? small? same answer twice? no tie at the LIMIT?
                      ├── guard ────── refuses anything but a read
                      ├── Zetaris ──── runs your query (TPCDS_DB, NY_TAXI)
                      ├── grader ───── compares your rows with the answer's, by value: the evidence
                      ├── coach ────── Nemotron turns the evidence into a hint ◄─┐
                      │                └── critic: does the hint leak the answer? ─┘ rewrite once, else use the case's own hint
                      ├── coach ────── judges your "why"
                      └── designer ─── Nemotron drafts a new case for your weakest skill ◄─┐
                                       └── validator checks it on Zetaris; failures go back ─┘ up to 3 tries
```

The agents work in loops, not a chain: the designer and the validator go back and forth until a case is fair; the coach and the critic go back and forth until a hint is safe; memory decides which case comes next and what the coach knows about you. If Nightshift is down, the game keeps going on the cases' own hints.

## Sponsor technology

| | What it does here | Where |
|---|---|---|
| **Zetaris** | Holds the data every case is built on, runs each case's reference query (to check the case and get its answer) and every query the player writes, over its REST API | `src/zetaris/client.ts`, `src/game/cases.ts`, `src/game/engine.ts` |
| **Meterless H-MEM** (engine) | The player's memory. Mistakes and solved cases are written as H-MEM records with a source and confidence; before each case the game recalls through H-MEM retrieval; a recalled note that helped gets `feedback("helpful")`; clicking a memory shows its trust-ledger history | `src/game/memory.ts`, engine in `vendor/meterless/hmem` |
| **Meterless Runtime / Nightshift** | The AI provider for every model call, implemented to the Power prompt's contract (bearer token, `meterless-app`, `meterless-scope`, status from `GET /v1/models`, retries) | `src/meterless/provider.ts` |
| **NVIDIA Nemotron** | Runs behind Nightshift: Nemotron 3.5 Lightning 30B and Nemotron 3 Super 120B lanes. The trace shows which model answered each call | Nightshift lanes; `src/agents/` |

**Proof the engine works:** `npm run conformance:hmem` runs H-MEM's own conformance suite against the engine this game uses (13/13), and `npm test` includes a test where memory persists across sessions, recalls a past mistake for a related case, and raises a note's confidence after it helped.

## Setup

What you need running on your machine:

1. **Zetaris**, locally in Docker, from the hackathon's setup guide: register at [Zetaris Cloud](https://cloud.enterprise.zetaris.com/register), download the platform bundle from its *Run locally* page, then `./preflight.sh`, `docker compose up -d` and `./verify.sh` (see [Zetaris getting started](https://zetaris.github.io/getting-started/)). It ships with the `TPCDS_DB` and `NY_TAXI` sample databases the cases use. Create an API key under **Management → API Tokens**.
2. **Meterless Nightshift** from [meterless.ai](https://meterless.ai), with an NVIDIA key from [build.nvidia.com](https://build.nvidia.com/models) added under **Setup → Providers → NVIDIA**, and at least one Nemotron lane. Copy the runtime URL and token from Nightshift's **Console**.
3. **Node.js 22 or later.**

Then:

```
git clone https://github.com/JannetEkka/sql-noir
cd sql-noir
npm install
cp .env.example .env          # on Windows: Copy-Item .env.example .env
```

Fill in `.env`: `ZETARIS_API_KEY` and `METERLESS_RUNTIME_TOKEN` (the other values are the local defaults). Then:

```
npm run smoke                 # checks Zetaris and Nightshift together; every line should say PASS
npm start                     # then open http://localhost:4321
```

## Playing

1. **Next case** opens a case. The validator checks it against the data first; the trace at the bottom shows each check.
2. Write a query and run it (Ctrl+Enter). If it's wrong, the **Evidence** panel shows what doesn't match and the **Coach** gives a hint. Hints get more specific with each attempt: a nudge, then the concept, then a skeleton with blanks.
3. When your result matches, explain **why** your query proves it. The coach judges the explanation, and the case closes with the reference query revealed.
4. **Memory** lists what the game has learned about you. Click a note to see its H-MEM trust ledger.
5. **Design a case** asks Nemotron for a new case aimed at your weakest skill. It only reaches you after passing the validator on Zetaris.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Runs the game on http://localhost:4321 |
| `npm test` | 42 unit and integration tests; no services needed |
| `npm run typecheck` | TypeScript check |
| `npm run smoke` | Checks Zetaris and Nightshift together and records their replies in `fixtures/recorded` |
| `npm run record:schema` | Records the sample databases' tables, columns and a few rows |
| `npm run validate:cases` | Puts every seed case through the validator against your Zetaris |
| `npm run conformance:hmem` | Runs the H-MEM conformance suite against the vendored engine |

Every agent step is also appended to `.data/trace.jsonl`; player memory lives in `.data/memory`.

## Project layout

```
src/zetaris/      REST client and the read-only SQL guard
src/meterless/    Meterless Runtime provider (Nightshift)
src/game/         grader (compare.ts), cases and validator, seed cases, picker, H-MEM memory, engine, trace
src/agents/       coach and critic, case designer, model JSON helpers
src/server.ts     built-in http server and JSON API
public/           the page
scripts/          smoke test, schema recorder, case validation
vendor/meterless/hmem   H-MEM engine and its conformance suite (unmodified)
```

There are no runtime dependencies. The only installs are the development tools: tsx, TypeScript and Node's types.

## Limits

- Cases run on Zetaris's sample data, so the stories are fiction laid over a benchmark retail dataset and NYC taxi zones.
- Player answers are compared by values. Rounding differences beyond 6 decimal places, or a different but equivalent representation of a date, count as different.
- The critic catches answer values and quoted reference SQL in hints. It can't catch a hint that paraphrases the answer.
- One player at a time. The game is meant to run on your own machine, next to your Zetaris and Nightshift.

## Pre-existing components

- `vendor/meterless/hmem`: the H-MEM reference and conformance suite from [Meterless/Meterless](https://github.com/Meterless/Meterless), copied unmodified (Apache-2.0). See `vendor/meterless/hmem/VENDORED.md`.

Everything else was written during the hackathon window, starting Oct 22, 2026, 00:00 UTC.

## How AI tools were used

Claude Code wrote most of the code in cloud sessions, with tests run there against stand-ins for Zetaris and Nightshift. Jannet Ekka runs and checks it against the real stack (local Zetaris and Nightshift) in Cursor.
