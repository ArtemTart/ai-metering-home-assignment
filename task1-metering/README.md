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

Settings are in [`.env`](.env): `DEFAULT_CREDIT_LIMIT` (default 5), `QUOTA_PERIOD` (`hour`, `day` or `month`), and the simulated AI's delay, failure rate and timeout.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/ai/requests` | Header `x-user-id`, body `{"prompt": "..."}`. Returns `200` with the answer, `429` if the limit is reached, `502`/`504` if the AI failed or timed out (credit refunded), or `400` for invalid input. |
| `GET /v1/users/:userId/usage` | `{ limit, used, remaining, periodStart, periodEnd }` |

## How it works

Each request is one row in `usage_events`:

1. **Reserve.** In a single SQLite transaction, count the user's credits in the current period. If the count is below the limit, insert a `RESERVED` row; otherwise return 429. The transaction takes the write lock before counting, so parallel requests can't both get the last credit.
2. **Call the AI** (simulated: random delay and occasional failure), with a timeout.
3. **Settle.** Mark the row `COMMITTED` on success, or `REFUNDED` on failure or timeout. Refunded rows stay in the table as evidence but don't count against the limit.

Periods are fixed, calendar-aligned UTC windows (e.g. a calendar month).

## What's not implemented

- **Idempotency keys:** a retried request is charged again. This is described in the design.
- **Recovery after a crash** between reserve and settle: the row would stay `RESERVED` and keep counting against the limit.
- **Authentication:** the user is taken from the `x-user-id` header.
- **Admin API** for changing limits: the limit comes from `.env`.
