import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { sign } from './signature.js';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const CONCURRENCY = 10;            // how many deliveries this worker sends at the same time
const TIMEOUT_MS = 5000;           // stop waiting for an endpoint after 5 s
const HIDE_SECONDS = 30;           // a taken job is hidden this long (visibility timeout)
const RETRY_DELAYS = [1, 2, 4, 8]; // seconds to wait before each retry (short for the local demo)
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;

const pool = new pg.Pool({ connectionString: DATABASE_URL });
pool.on('error', (error) => console.error('Idle database connection failed', error.code));

// Take one due job and hide it, in a single statement.
// SKIP LOCKED lets many loops and many workers run this at once without taking the same job.
async function claim() {
  const { rows } = await pool.query(
    `WITH job AS (
       UPDATE deliveries
       SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $1)
       WHERE id = (SELECT id FROM deliveries
                   WHERE state = 'pending' AND next_attempt_at <= now()
                   ORDER BY next_attempt_at
                   LIMIT 1
                   FOR UPDATE SKIP LOCKED)
       RETURNING id, event_id, endpoint_id, attempts
     )
     SELECT job.id, job.attempts, e.event_type, e.payload, e.created_at, p.url, p.signing_secret
     FROM job
     JOIN events e ON e.id = job.event_id
     JOIN endpoints p ON p.id = job.endpoint_id`,
    [HIDE_SECONDS],
  );
  return rows[0];
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

async function handle(job) {
  // The worker that made the last attempt never reported back (it crashed), so give up.
  if (job.attempts > MAX_ATTEMPTS) {
    return save(job, 'dead', 'worker stopped during the last attempt');
  }

  const error = await send(job);
  console.log(`${job.url} attempt ${job.attempts}: ${error ?? 'delivered'}`);

  if (!error) return save(job, 'delivered', null);
  if (job.attempts >= MAX_ATTEMPTS) return save(job, 'dead', error);
  return save(job, 'pending', error, RETRY_DELAYS[job.attempts - 1]);
}

// "AND attempts = $2": if another worker took this job after us, its attempts
// number is higher, so our old result is ignored.
async function save(job, state, error, retryInSeconds = 0) {
  await pool.query(
    `UPDATE deliveries
     SET state = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5)
     WHERE id = $1 AND attempts = $2`,
    [job.id, job.attempts, state, error, retryInSeconds],
  );
}

async function runLoop() {
  while (true) {
    try {
      const job = await claim();
      if (job) await handle(job);
      else await sleep(1000); // nothing due: look again in a second
    } catch (error) {
      console.error('Worker error:', error.message); // e.g. database down: wait and try again
      await sleep(1000);
    }
  }
}

for (let i = 0; i < CONCURRENCY; i++) runLoop();
console.log(`Worker started: ${CONCURRENCY} deliveries at a time`);
