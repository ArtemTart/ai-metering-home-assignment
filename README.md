# Task 1 — AI Usage Metering

Node.js + TypeScript (Fastify, SQLite). Every AI request costs one credit, each user has a limited number of credits per period, and every request is stored as evidence.

Design document: [`docs/DESIGN.md`](docs/DESIGN.md). Production plan: [`docs/PRODUCTION.md`](docs/PRODUCTION.md).

## Run

Requires Node.js 20.6+.

```bash
npm start     # installs dependencies and starts on http://localhost:3000
npm test
```

**Swagger UI: <http://localhost:3000/docs>**

Settings are in [`.env`](.env): `DEFAULT_CREDIT_LIMIT` (default 5), `QUOTA_PERIOD` (`hour`, `day` or `month`), `DEDUPE_WINDOW_SECONDS` (default 10, 0 = off), the simulated AI's delay and failure rate, `AI_TIMEOUT_MS` (deadline for the whole call), and `AI_RETRIES` / `AI_RETRY_BACKOFF_MS`.

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
2. **Call the AI** (simulated: random delay and occasional failure). Failures are retried up to `AI_RETRIES` times with exponential backoff and jitter. The default is 0, so the simulated failures are visible as 502s; with retries on, the response's `attempts` field and a log line show each retried failure. One deadline (`AI_TIMEOUT_MS`) covers all attempts, and on expiry the in-flight call is cancelled with an `AbortSignal`.
3. **Settle.** Mark the row `COMMITTED` on success, or `REFUNDED` on failure or timeout. Refunded rows stay in the table as evidence but don't count against the limit.

Periods are fixed, calendar-aligned UTC windows (e.g. a calendar month).

**Shutdown and crashes:** `Ctrl+C` or `SIGTERM` stops accepting requests and waits for in-flight ones to settle before closing the database. If the process crashes instead, a sweeper (at startup and every 30 s) refunds reservations older than the AI timeout + 30 s, with the reason `RESERVATION_EXPIRED`.

## Retries: `Idempotency-Key`

Send an optional `Idempotency-Key` header, e.g. a UUID generated once per request and **reused on every retry**:

| Repeat of the key | Response |
|---|---|
| First request finished | The stored answer, `200` with `"replayed": true` (and header `idempotent-replayed: true`). Not charged, AI not called. |
| First request still running | `409 REQUEST_IN_PROGRESS` |
| Used with a different prompt | `409 IDEMPOTENCY_KEY_REUSED` |
| First attempt failed (refunded) | A real new attempt, because the user never got an answer |

A retry storm of 20 simultaneous copies costs one AI call and one credit. The key check runs in the same atomic transaction as the quota check, backed by a unique index on `(user_id, idempotency_key)` that excludes refunded rows.

In a real client the key is not typed by hand. The client code generates it (`crypto.randomUUID()`) once per user action and resends it on retries.

**Without a key**, there is an automatic fallback: the same user sending the **same prompt** within `DEDUPE_WINDOW_SECONDS` (default 10) gets the same replay or 409 behaviour. The trade-off is that a user who deliberately asks the same question twice within the window gets the first answer back. After the window, or with a different prompt, it's a new charged request. An explicit key always takes precedence, and `0` turns the fallback off.

## Async model

Node.js runs one thread; `await` frees it while waiting, so thousands of requests can wait on the AI at once. The rule used here: **`await` only where something actually waits.**

| Operation | Sync / async | Why |
|---|---|---|
| AI call, retry backoff | `async` | Slow network I/O (seconds). Uses one `AbortSignal.timeout(T)` for the whole call: it cancels the in-flight attempt, the backoff sleep (`timers/promises` with `signal`), and stops further retries. |
| Database (`better-sqlite3`) | **sync, on purpose** | In-process, microseconds. The reservation (idempotency check → count → insert) has **no `await` inside**, so no other request can interleave; the SQLite write lock covers other processes. Async here would add overhead and weaken that argument. |
| Shutdown | `async` | `await app.close()` waits for in-flight requests before `db.close()`. |

Details worth knowing:
- **Cancel, don't just abandon.** A plain `Promise.race` timeout only stops *waiting*; the provider keeps working and billing. The signal is passed to the AI call so it stops. A provider that ignores the signal is still cut off (the race is kept as a fallback).
- **Retries only within the deadline**, never `T × retries`; jitter (×0.5–1.5) prevents many clients retrying in sync. In production, retry only transient errors (5xx, 429, network), not 4xx.
- **With PostgreSQL** the driver is async: the reservation becomes `await BEGIN … COMMIT`, and atomicity comes from row locks (`SELECT … FOR UPDATE` / conditional `UPDATE`), not from the absence of `await`.
- **The sweeper threshold must exceed T** (a live request always settles within T), otherwise it could refund a request that is about to succeed. If that ever happened, the guarded settle (`WHERE status = 'RESERVED'`) makes the late commit a no-op: the user gets the answer for free — the safe direction.

## Simulated AI failures vs. retries

The assignment requires the simulated AI to fail occasionally (`AI_FAILURE_RATE`, default 0.2 = about 1 in 5 calls). Automatic retries work against that visibility: with 2 retries a request only fails if all 3 attempts fail (0.2³ ≈ 0.8%), so failures practically disappear from the API.

| `AI_RETRIES` | What the client sees | When to use |
|---|---|---|
| **0** (default) | About 1 in 5 requests → 502 `AI_ERROR`, credit refunded. | Local demo and tests: the required failure behaviour is visible. |
| 2 | Most failures are absorbed: 200 with `"attempts": 2` or `3`. Only ~0.8% end in 502. | Production: transient provider errors shouldn't reach the user. |

Retries must never make problems invisible to operators: every failed attempt is logged with the `requestId`, the response reports `attempts`, and the 502 message says how many attempts were made. In production, a rising retry rate is an alert signal (provider degrading) even while users still get 200s.

## What's not implemented

- **Circuit breaker** around the AI provider (see the design document).
- **Authentication:** the user is taken from the `x-user-id` header, and the quota endpoints are open (in production they would require admin rights).
