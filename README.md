# Developer Home Assignment

Two **independent** tasks in one repo. Each has its own folder, dependencies, README, and `npm start` / `npm test`. Run them separately from their own directories.

Requires Node.js 20.6+.

## Task 1 — AI Usage Metering & Quota

```bash
cd task1-metering
npm start    # http://localhost:3000  · Swagger: /docs
npm test
```

Design: [`task1-metering/docs/DESIGN.md`](task1-metering/docs/DESIGN.md) · Production: [`task1-metering/docs/PRODUCTION.md`](task1-metering/docs/PRODUCTION.md) · Details: [`task1-metering/README.md`](task1-metering/README.md)

## Task 2 — Shared-State Team Task Board

```bash
cd task2-taskboard
npm start    # http://localhost:5173  (mock server on :3001)
npm test
```

Details: [`task2-taskboard/README.md`](task2-taskboard/README.md)

Optional convenience from the repo root (still runs each project on its own):

```bash
npm test    # runs each task's tests in turn
```

## AI tools note

AI (Cursor) was used throughout for scaffolding, tests, and documentation. Every line was reviewed and can be explained; design decisions (reserve→settle, Pinia + computed derived data, SSE) were chosen before code was written.
