import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { sign } from './signature.js';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const LOOPS = 10;                  // loops running side by side in this worker
const BATCH_SIZE = 50;             // jobs each loop takes per query (so up to 500 sends at once)
const TIMEOUT_MS = 5000;          // stop waiting for an endpoint after 5 s
const HIDE_SECONDS = 30;           // a taken job is hidden this long (visibility timeout)
const RETRY_DELAYS = [1, 2, 4, 8]; // seconds to wait before each retry (short for the local demo)
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;

const pool = new pg.Pool({ connectionString: DATABASE_URL });
pool.on('error', (error) => console.error('Idle database connection failed', error.code));

// Take up to BATCH_SIZE due jobs and hide them, in a single statement.
// SKIP LOCKED lets many loops and many workers run this at once without taking the same job.
async function claim() {
  const { rows } = await pool.query(
    `WITH jobs AS (
       UPDATE deliveries
       SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $1)
       WHERE id = ANY(ARRAY(SELECT id FROM deliveries
                            WHERE state = 'pending' AND next_attempt_at <= now()
                            ORDER BY next_attempt_at
                            LIMIT $2
                            FOR UPDATE SKIP LOCKED))
       RETURNING id, event_id, endpoint_id, attempts
     )
     SELECT jobs.id, jobs.attempts, e.event_type, e.payload, e.created_at, p.url, p.signing_secret
     FROM jobs
     JOIN events e ON e.id = jobs.event_id
     JOIN endpoints p ON p.id = jobs.endpoint_id`,
    [HIDE_SECONDS, BATCH_SIZE],
  );
  return rows;
}

// Send the webhook. Returns null if it worked, or a short reason if it failed.
async function send(job) {
  const body = JSON.stringify({
    id: job.id, // same on every retry, so the receiver can skip duplicates
    type: job.event_type,
    createdAt: job.created_at,
    data: job.payload,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));

  try {
    const response = await fetch(job.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Webhook-Timestamp': timestamp,
        'Webhook-Signature': sign(job.signing_secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok ? null : `HTTP ${response.status}`;
  } catch (error) {
    return error.name === 'TimeoutError' ? 'timeout' : (error.cause?.code ?? error.message);
  }
}

// Send one job and decide what happens to it next. Returns the row's new values.
async function handle(job) {
  const result = (state, error = null, wait = 0) => ({ id: job.id, attempts: job.attempts, state, error, wait });

  // The worker that made the last attempt never reported back (it crashed), so give up.
  if (job.attempts > MAX_ATTEMPTS) return result('dead', 'worker stopped during the last attempt');

  const error = await send(job);
  console.log(`${job.url} attempt ${job.attempts}: ${error ?? 'delivered'}`);

  if (!error) return result('delivered');
  if (job.attempts >= MAX_ATTEMPTS) return result('dead', error);
  return result('pending', error, RETRY_DELAYS[job.attempts - 1]);
}

// Save the results of a whole batch in one statement.
// "d.attempts = r.attempts": if another worker took a job after us, its attempts
// number is higher, so our old result for that job is ignored.
async function saveAll(results) {
  await pool.query(
    `UPDATE deliveries d
     SET state = r.state, last_error = r.error, next_attempt_at = now() + make_interval(secs => r.wait)
     FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, attempts int, state text, error text, wait int)
     WHERE d.id = r.id AND d.attempts = r.attempts`,
    [JSON.stringify(results)],
  );
}

async function runLoop() {
  while (true) {
    try {
      const jobs = await claim();
      if (jobs.length === 0) {
        await sleep(1000); // nothing due: look again in a second
        continue;
      }
      const results = await Promise.all(jobs.map(handle)); // send the whole batch at the same time
      await saveAll(results);                               // one write for the whole batch
    } catch (error) {
      console.error('Worker error:', error.message); // e.g. database down: wait and try again
      await sleep(1000);
    }
  }
}

for (let i = 0; i < LOOPS; i++) runLoop();
console.log(`Worker started: ${LOOPS} loops, up to ${BATCH_SIZE} jobs each`);
