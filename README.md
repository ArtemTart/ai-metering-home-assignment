# Developer Home Assignment

Two tasks in one repo. Each has its own folder, README, and `npm start` / `npm test`.

Requires Node.js 20.6+.

## From the repo root

```bash
npm test    # run all tests (Task 1: 83 + Task 2: 40), then exit
npm start   # start Task 2 (task board) at http://localhost:5173
```

`npm start` and `npm test` are separate: tests print in the terminal and exit; start keeps the app running. To run Task 1, use the commands in its section below.

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

## AI tools note

AI (Cursor) was used throughout for scaffolding, tests, and documentation. Every line was reviewed and can be explained; design decisions (reserve→settle, Pinia + computed derived data, SSE) were chosen before code was written.
