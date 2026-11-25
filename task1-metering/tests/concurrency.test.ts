import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';

const run = promisify(execFile);
const worker = fileURLToPath(new URL('./support/reserveWorker.ts', import.meta.url));

/**
 * In-process tests can't produce a real race: better-sqlite3 is synchronous. This simulates
 * several server instances, each its own process with its own connection to the same database file.
 */
describe('quota under real multi-process contention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metering-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('never grants more than the limit across instances', { timeout: 30_000 }, async () => {
    const dbPath = join(dir, 'shared.db');
    openDb(dbPath).close();

    const processes = 4;
    const attemptsEach = 40;
    const limit = 50;
    const startAt = Date.now() + 2000;

    const results = await Promise.all(
      Array.from({ length: processes }, () =>
        run(process.execPath, ['--import', 'tsx', worker, dbPath, String(attemptsEach), String(limit), String(startAt)]),
      ),
    );
    const counts = results.map((r) => JSON.parse(r.stdout) as { reserved: number; rejected: number });

    expect(counts.reduce((sum, c) => sum + c.reserved, 0)).toBe(limit);
    expect(counts.reduce((sum, c) => sum + c.rejected, 0)).toBe(processes * attemptsEach - limit);

    const db = openDb(dbPath);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM usage_ledger`).get()).toEqual({ n: limit });
    expect(db.prepare(`SELECT reserved FROM user_period_usage`).get()).toEqual({ reserved: limit });
    db.close();
  });
});
