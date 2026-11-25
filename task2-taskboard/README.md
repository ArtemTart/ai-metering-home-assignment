# Task 2 — Shared-State Team Task Board

Vue 3 (Composition API) + Pinia + TypeScript, with a Node.js mock server (Fastify) that pushes changes over Server-Sent Events.

## Run

Requires Node.js 20.6+.

```bash
npm start     # installs dependencies, starts the mock server (:3001) and the app (:5173), opens the browser
npm test      # store logic, components, server, config — output is in the terminal
npm run typecheck
```

`npm start` runs the app; `npm test` runs the tests and exits. They are not the same command. From the repo root, `npm test` runs Task 1 and Task 2 together.

To list every test name:

```bash
npx vitest run --reporter=verbose
```

| Test file | What it covers |
|---|---|
| `tests/store.test.ts` | Shared-state logic: versions, optimistic updates, in-flight lock, derived counts/groupings |
| `tests/components.test.ts` | One edit or server push updates every panel; "Saving…" while in flight |
| `tests/server.test.ts` | REST, SSE stream, dead-subscriber isolation, simulator |
| `tests/connection.test.ts` | Malformed SSE frames are ignored |
| `tests/config.test.ts` | `.env` validation |

The app is at <http://localhost:5173>. Settings are in [`.env`](.env): `PORT`, `SIMULATOR_INTERVAL_MS`, `MAX_ACTIVITY`, `MIN_TASKS` / `MAX_TASKS`, `SSE_HEARTBEAT_MS`, `VITE_MIN_PENDING_MS`.

## Saving / Adding indicator

While a create, update or delete is in flight:

- the task row shows **Saving…**, dims slightly, and its dropdowns / delete are disabled
- the Add button shows **Adding…**
- the editor Save button shows **Saving…**

A second click on the same task is ignored until the first request finishes (per-task in-flight lock). On localhost the API answers in ~1ms, so `VITE_MIN_PENDING_MS` (default **450**) keeps the indicator visible long enough to see. Set it to `0` to turn that minimum off.

## What's on the screen

| Panel | What it does |
|---|---|
| **Tasks** | All tasks; change assignee/status/priority inline, delete, add a task |
| **Editor** | Edit the selected task (title, assignee, status, priority) |
| **Summary** | Counts by status and by assignee |
| **By assignee** | Tasks grouped by person |
| **Activity** | Recent changes, marked `user` or `server` |

## State-management approach

```
             user action                          server push (SSE)
  [any panel] ──────────► store action ──► api ──► mock server ──► event ──┐
                               │                                           │
                               ▼                                           ▼
                     ┌────────────────────────────────────────────────────────┐
                     │ Pinia store (single source of truth)                  │
                     │   source:  tasks (by id), activity, selectedId        │
                     │   derived: taskList, countsByStatus, countsByAssignee, │
                     │            tasksByAssignee, selectedTask  (computed)  │
                     └────────────────────────────────────────────────────────┘
                               │ reactive reads
              ┌────────┬───────┴──┬────────────┬─────────────┐
            Tasks   Editor    Summary   By assignee    Activity
```

1. **One store, one copy of the data.** All tasks live in one Pinia store ([`src/stores/board.ts`](src/stores/board.ts)). Components never keep their own copy; they read from the store and change data only through its actions. A user edit and a server push go through the same code path, so they can't behave differently.

2. **Derived data is computed, never stored.** Counts and groupings are Vue `computed` values over the tasks. Vue recalculates them whenever a task they depend on changes, so they cannot be out of sync: there is no second copy to forget to update. Components don't compute anything themselves either, so two panels can't disagree.

3. **The server is the authority; the client is optimistic.**
   - A user change is applied to the store immediately (every panel updates before the server answers), then replaced by the server's version.
   - If the server rejects it, the previous value is restored and an error is shown, unless the server has sent a newer version meanwhile; then that one wins.
   - Every task has a `version` that the server increments on each change. The client ignores any task data older than (or equal to) what it already has, so duplicate or late messages can't overwrite newer data.

4. **SSE for server changes.** The server pushes `task.upserted` / `task.deleted` events. On every (re)connect it first sends a **full snapshot**, which replaces the client's state, so anything missed while offline is corrected. The browser's `EventSource` reconnects automatically; the header shows `Live` / `Offline, reconnecting…`.

**Why Pinia + `computed`:** Vue's reactivity tracks which data each `computed` value and component uses and updates exactly those, which is precisely the "derived data never out of sync" requirement. Pinia is Vue's official store: one place for the data and the actions that change it, testable without the UI. Alternatives I didn't pick: per-component state with props/events (copies drift apart, and the server updates would have to be threaded through every component); `provide`/`inject` with a plain `reactive` object (works, but Pinia adds devtools and a clearer action layer for the same effort).

**Why Vue rather than React:** the assignment prefers React, but also says any approach is fine if it can be explained. Vue is the framework I know best, and being able to explain every line mattered more. The approach itself (single source of truth, computed derived data, versioned server events) carries over to React directly (`useReducer` + Context or Zustand, with selectors / `useMemo`).

**Why SSE:** updates only flow server → client (user changes go through normal REST calls), so a one-way stream is enough. It's plain HTTP, needs no library, and `EventSource` reconnects automatically. WebSocket would add a protocol and manual reconnect logic for no gain; polling would add delay and wasted requests.

## Edge cases

| Case | Handling |
|---|---|
| Same task changed by the user and the server at once | Updates are field-level (`PATCH` sends only changed fields), so edits to different fields both survive; for the same field, the last write wins. |
| Server changes the task you're editing | The editor keeps your draft and shows "Someone else changed this task", with an option to load theirs; saving sends only the fields you changed. Without unsaved edits it just refreshes. |
| Server deletes the task you're editing | The editor shows "This task was deleted". |
| Editing a task that was deleted meanwhile | Server returns 404; the task disappears and the user is told why. |
| Duplicate or out-of-order messages | Ignored by the version check. The activity feed is de-duplicated by entry ID. |
| A late update for a deleted task | Ignored: deleted IDs are remembered, so the task isn't resurrected. |
| Connection lost | Header shows "Offline"; `EventSource` reconnects and the snapshot resyncs everything. |
| Save or delete fails | Optimistic change is rolled back (unless a newer server version arrived) and an error banner is shown. |
| Rapid double-click on the same task | Second click ignored while **Saving…** is shown; controls disabled until the request finishes. |
| Dead SSE subscriber / bad SSE JSON | Failing subscriber is dropped; malformed frames are ignored so others keep working. |
| Empty or whitespace-only title | Blocked in the UI and rejected by the server (400). |
| Invalid values (unknown person/status, extra fields, wrong types) | Rejected by the server's schema (400). |
| A change that changes nothing | No new version and no activity entry. |
| Simulator deletes too much | It never goes below 3 tasks (nor above 15). |

## Project structure

```
shared/types.ts          types used by both server and client (Task, ServerEvent, ...)
server/
  board.ts               in-memory tasks, activity log, subscribers
  app.ts                 REST endpoints + SSE stream
  simulator.ts           random changes "from the other side"
  index.ts               entry point
src/
  stores/board.ts        the Pinia store: source state, computed derived data, actions
  connection.ts          SSE → store
  api.ts                 REST calls
  components/            TaskList, TaskEditor, SummaryPanel, AssigneeView, ActivityLog
tests/
  store.test.ts          events, versions, optimistic updates/rollback, derived data (incl. 500 random events)
  components.test.ts     edits in one panel show in all others; editor conflict / deleted / validation
  server.test.ts         REST validation, field-level updates, SSE snapshot + live events, simulator
```

## Not implemented

- **Persistence:** the mock server keeps tasks in memory; restarting it resets the board.
- **Authentication / real users:** the actor is just "user" or "server"; two open tabs both appear as "user".
- **Offline editing queue:** edits made while disconnected fail (and roll back) instead of being queued.
- **Undo, filtering, sorting options, drag-and-drop:** out of scope for the shared-state focus.

Production edge cases, bottlenecks and a go-live plan: [`docs/PRODUCTION.md`](docs/PRODUCTION.md).
