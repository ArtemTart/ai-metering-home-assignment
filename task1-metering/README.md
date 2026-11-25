# Task 1 — AI Usage Metering & Quota Service

A Node.js + TypeScript (Fastify, SQLite) service that meters AI requests, enforces a per-user credit limit per period and keeps an immutable ledger of every credit as evidence.

The design document is in [`docs/DESIGN.md`](docs/DESIGN.md). It covers the architecture, data model, enforcement, edge cases, failure handling, scaling and trade-offs.

## Run

Requires Node.js 20+.

```bash
npm start
```

This installs dependencies (via `prestart`) and starts the server on `http://localhost:3000`. The SQLite database is created at `data/metering.db`.

**Interactive API docs (Swagger UI): <http://localhost:3000/docs>**. The OpenAPI spec is at `/docs/json`. It is generated from the same JSON schemas that validate requests, so the docs can't drift from the actual validation.

```bash
npm test          # all tests (unit, HTTP integration, multi-process concurrency)
npm run typecheck
```

### Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `DEFAULT_CREDIT_LIMIT` | `100` | Credits per user per period (X) |
| `QUOTA_PERIOD` | `month` | `hour`, `day` or `month` (calendar-aligned, UTC) |
| `AI_TIMEOUT_MS` | `3000` | AI call timeout; on timeout the credit is refunded |
| `AI_MIN_DELAY_MS` / `AI_MAX_DELAY_MS` | `200` / `1500` | Simulated AI latency range |
| `AI_FAILURE_RATE` | `0.1` | Probability that the simulated AI fails |
| `RESERVATION_GRACE_MS` | `30000` | Extra time after the timeout before an unsettled reservation counts as orphaned |
| `REAPER_INTERVAL_MS` | `10000` | How often orphaned reservations are refunded |
| `PORT`, `HOST`, `DB_PATH`, `LOG_LEVEL` | `3000`, `localhost`, `data/metering.db`, `info` | |

Invalid values stop the server at startup with a clear message.

## API

```bash
# Make an AI request (1 credit). Idempotency-Key is optional but makes retries safe.
curl -X POST localhost:3000/v1/ai/requests \
  -H 'content-type: application/json' -H 'x-user-id: alice' -H 'idempotency-key: 7f1c...' \
  -d '{"prompt":"Hello"}'

# Current usage and remaining credits
curl localhost:3000/v1/users/alice/usage

# Evidence: ledger rows, including refunded attempts
curl 'localhost:3000/v1/users/alice/ledger?limit=20'

# Per-user limit override (an admin operation; unauthenticated in this demo)
curl -X PUT localhost:3000/v1/users/alice/limit -H 'content-type: application/json' -d '{"limit":5}'
```

| Status | When |
|--------|------|
| `200` | Success; one credit committed. Replays carry `idempotent-replayed: true`. |
| `400` | Invalid header or body (strict: no coercion, no unknown fields) |
| `409` | `IDEMPOTENCY_KEY_REUSED` (different body) or `REQUEST_IN_PROGRESS` |
| `413` | Body larger than 16 KB |
| `429` | `QUOTA_EXCEEDED`; `Retry-After` gives the seconds until the period resets |
| `502` / `504` | AI failed or timed out; the credit was refunded (`creditRefunded: true`) |
| `503` | Usage store unavailable: fails closed, so the request was not processed or charged |

## How it works (short version)

1. **Reserve.** A single SQLite write transaction checks the idempotency key, then runs `UPDATE counter SET reserved = reserved + 1 WHERE reserved + committed + 1 <= limit`. If no row changed, the response is 429. Otherwise a `RESERVED` ledger row is inserted.
2. **Call the AI**, with a timeout.
3. **Settle.** The row becomes `COMMITTED` on success or `REFUNDED` (with a reason) on failure. Settlement only applies to rows still `RESERVED`, so it is idempotent and can't race with the reaper.
4. **Reaper.** Refunds reservations orphaned by a crash (`RESERVATION_EXPIRED`).

The ledger is append-only, and SQLite triggers reject deletes and rewrites.

## What is implemented

- All minimum requirements: the AI endpoint with a simulated AI (random delay and failures), per-user limit enforcement, every attempt recorded as evidence, and the usage endpoint.
- Reserve, commit or refund, with refunds on AI errors and timeouts.
- Idempotency keys: replay, body-mismatch conflict, in-flight conflict, and a new attempt allowed after a refunded failure.
- Fixed UTC periods (hour, day or month); a request straddling a boundary is counted in the period it was reserved in.
- Per-user limit overrides, effective immediately (no clawback when a limit is lowered).
- Fail-closed behavior when the database is unavailable; settlement retries; the orphaned-reservation reaper.
- Ledger immutability enforced by the database; a ledger endpoint for audits.
- Graceful shutdown that waits for in-flight requests to settle.

## Tests (58)

- `tests/metering.test.ts`: the quota, periods, settlement races, idempotency states, immutability, and a randomized test that the counters always equal the ledger.
- `tests/api.test.ts`: every HTTP status path, parallel requests (exactly `limit` succeed), timeouts, store outage, settlement failure recovered by the reaper, and validation.
- `tests/concurrency.test.ts`: four separate OS processes contend on one database file. This simulates several server instances; exactly `limit` reservations succeed.
- `tests/period.test.ts`: period boundaries, year rollover, leap years, DST.

The AI client and the clock are injected, so tests are deterministic and need no sleeps.

## What is missing, and why

| Not implemented | Why |
|-----------------|-----|
| Authentication / authorization | Out of scope; the user comes from `X-User-Id`. The admin endpoint would need admin auth. |
| Circuit breaker for the AI provider | Designed in `DESIGN.md` §5; not needed with a simulated provider within the time budget. |
| Reconciliation job | Designed; the invariant it would check (counters equal the ledger) is asserted in tests instead. |
| Per-user period configuration | The period is global. Per-user periods would need period info on the counter row. |
| Variable credit cost (e.g. per token) | The schema has a `credits` column, but every request costs 1, as specified. |
| PostgreSQL, Redis, sharding, archiving | Production scaling path, described in `DESIGN.md` §6. |
| Testing that a client disconnect doesn't abort the call | The behavior holds (the handler doesn't watch the socket), but there's no automated test for it. |
