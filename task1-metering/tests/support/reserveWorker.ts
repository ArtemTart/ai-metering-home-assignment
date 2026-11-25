// Runs in a separate OS process: hammers the shared database through its own connection.
import { systemClock } from '../../src/clock.js';
import { openDb } from '../../src/db.js';
import { MeteringService } from '../../src/metering.js';

const [dbPath, attemptsArg, limitArg, startAtArg] = process.argv.slice(2);
const db = openDb(dbPath!);
const metering = new MeteringService(db, { defaultLimit: Number(limitArg), period: 'month' }, systemClock);

// Spin until a shared start time so all processes contend at once.
while (Date.now() < Number(startAtArg));

let reserved = 0;
let rejected = 0;
for (let i = 0; i < Number(attemptsArg); i++) {
  const outcome = metering.reserve({ userId: 'contended-user', requestHash: `h${i}` });
  if (outcome.kind === 'reserved') reserved++;
  else rejected++;
}
db.close();
process.stdout.write(JSON.stringify({ reserved, rejected }));
