# Developer Home Assignment

Two **independent** tasks in one repo. Each starts with **one command** (`npm start`) from its own folder.

Requires Node.js 20.6+.

## Task 1 — AI Usage Metering & Quota

```bash
cd task1-metering && npm start
# http://localhost:3000  · Swagger: /docs
```

Design: [`task1-metering/docs/DESIGN.md`](task1-metering/docs/DESIGN.md) · Production: [`task1-metering/docs/PRODUCTION.md`](task1-metering/docs/PRODUCTION.md) · Details: [`task1-metering/README.md`](task1-metering/README.md)

## Task 2 — Shared-State Team Task Board

```bash
cd task2-taskboard && npm start
# http://localhost:5173  · mock server on :3001
```

Details: [`task2-taskboard/README.md`](task2-taskboard/README.md)

```bash
# optional: run each project's tests from the repo root
npm test
```

## AI tools note

AI tools were used throughout this assignment, mainly inside **Cursor**:

- **Claude Opus 5.5** (via Cursor) — primary assistant for scaffolding, implementation, tests, design docs, and production notes.
- **ChatGPT** and **Gemini** — used as second opinions: some features, edge cases, and design choices were cross-checked and compared against their answers (for example quota concurrency, idempotency, shared-state approaches, and SSE vs WebSocket/polling). Where they disagreed with the Cursor/Claude draft or with each other, the final choice was made after reviewing the trade-offs, not by copying a single model’s output.

How AI was used in practice:

- Propose architecture and trade-offs before writing code (Task 1 design; Task 2 state model).
- Generate boilerplate (project layout, schemas, test skeletons) that was then edited by hand.
- Draft and refine tests for edge cases; run them locally and fix failures.
- Write and trim READMEs / design / production docs.

What AI did **not** replace: deciding the core approach, reading and understanding every submitted line, running the apps and tests locally, and judging what to leave out for a focused solution. Every line in this repo can be explained.
