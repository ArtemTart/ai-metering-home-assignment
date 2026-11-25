# Task 1 — AI Usage Metering

Node.js + TypeScript (Fastify, SQLite). Every AI request costs one credit, each user has a limited number of credits per period, and every request is stored as evidence.

Design document: [`docs/DESIGN.md`](docs/DESIGN.md).

## Run

Requires Node.js 20.6+.

```bash
npm start     # installs dependencies and starts on http://localhost:3000
npm test
```

**Swagger UI: <http://localhost:3000/docs>**

Settings are in [`.env`](.env): `DEFAULT_CREDIT_LIMIT` (default 5), `QUOTA_PERIOD` (`hour`, `day` or `month`), `DEDUPE_WINDOW_SECONDS` (default 10, 0 = off), and the simulated AI's delay, failure rate and timeout.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/ai/requests` | Header `x-user-id`, body `{"prompt": "..."}`. Returns `200` with the answer, `429` if the limit is reached, `502`/`504` if the AI failed or timed out (credit refunded), or `400` for invalid input. |
| `GET /v1/users/:userId/usage` | `{ limit, used, remaining, periodStart, periodEnd }` |
| `GET /v1/users` | All users (anyone with a request or a custom limit) with `limit`, `used`, `refunded`, `remaining` for the current period |
| `GET /v1/usage-events?userId=` | Raw rows of the evidence table, newest first (max 500); `userId` is optional |
| `PUT /v1/users/:userId/quota` | Body `{"limit": 10}`. Sets the user's credit limit, effective from their next request. |
| `DELETE /v1/users/:userId/quota` | Removes the custom limit; the user reverts to `DEFAULT_CREDIT_LIMIT`. |

The limit for a request is the user's row in `user_quotas` if one exists, otherwise `DEFAULT_CREDIT_LIMIT`. Lowering a limit below current usage blocks new requests but doesn't claw back credits already used.

## Project structure

```
src/
├── server.ts          entry point: config → db → app → listen
├── app.ts             Fastify setup, Swagger, route registration
├── config.ts          reads the environment (.env)
├── types/             all interfaces and types, no logic (barrel: types/index.ts)
├── schemas/           JSON schemas, used for both request validation and Swagger
├── routes/            ai.routes, usage.routes, admin.routes (one Fastify plugin each)
├── services/          quota.service (limits and evidence), ai.service (simulated AI and timeout)
├── db/database.ts     SQLite connection and tables
└── utils/period.ts    period boundaries
tests/app.test.ts      HTTP-level tests with an in-memory DB, a fake clock and a fake AI
```

Routes stay thin: they validate input via schemas and delegate to services. Services hold the logic and never see HTTP.

## How it works

Each request is one row in `usage_events`:

1. **Reserve.** In a single SQLite transaction, count the user's credits in the current period. If the count is below the limit, insert a `RESERVED` row; otherwise return 429. The transaction takes the write lock before counting, so parallel requests can't both get the last credit.
2. **Call the AI** (simulated: random delay and occasional failure), with a timeout.
3. **Settle.** Mark the row `COMMITTED` on success, or `REFUNDED` on failure or timeout. Refunded rows stay in the table as evidence but don't count against the limit.

Periods are fixed, calendar-aligned UTC windows (e.g. a calendar month).

## Retries: `Idempotency-Key`

Send an optional `Idempotency-Key` header, e.g. a UUID generated once per request and **reused on every retry**:

| Repeat of the key | Response |
|---|---|
| First request finished | The stored answer, `200` with `idempotent-replayed: true`. Not charged, AI not called. |
| First request still running | `409 REQUEST_IN_PROGRESS` |
| Used with a different prompt | `409 IDEMPOTENCY_KEY_REUSED` |
| First attempt failed (refunded) | A real new attempt, because the user never got an answer |

A retry storm of 20 simultaneous copies costs one AI call and one credit. The key check runs in the same atomic transaction as the quota check, backed by a unique index on `(user_id, idempotency_key)` that excludes refunded rows.

In a real client the key is not typed by hand. The client code generates it (`crypto.randomUUID()`) once per user action and resends it on retries.

**Without a key**, there is an automatic fallback: the same user sending the **same prompt** within `DEDUPE_WINDOW_SECONDS` (default 10) gets the same replay or 409 behaviour. The trade-off is that a user who deliberately asks the same question twice within the window gets the first answer back. After the window, or with a different prompt, it's a new charged request. An explicit key always takes precedence, and `0` turns the fallback off.

## What's not implemented

- **Recovery after a crash** between reserve and settle: the row would stay `RESERVED` and keep counting against the limit.
- **Authentication:** the user is taken from the `x-user-id` header, and the quota endpoints are open (in production they would require admin rights).
