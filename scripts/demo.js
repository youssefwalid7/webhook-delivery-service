// Shows the system working against good, failing, slow, flaky and offline customers.
// Run it with: docker compose run --rm demo
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { sign, verify } from '../src/signature.js';

const API = 'http://api:3000';
const RECEIVER = 'http://receiver:4000';
const ENDPOINTS = {
  ok: 'http://receiver:4000/ok',
  fail: 'http://receiver:4000/fail',
  slow: 'http://receiver:4000/slow',
  flaky: 'http://receiver:4000/flaky',
  down: 'http://receiver:4999/down', // nothing listens on this port
};

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const failures = [];

function check(passed, text) {
  console.log(`  ${passed ? '✓' : '✗'} ${text}`);
  if (!passed) failures.push(text);
}

async function post(path, body) {
  const response = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

// The state of each delivery of our event, by endpoint name.
async function states(eventId) {
  const { rows } = await db.query(
    `SELECT p.url, d.state, d.attempts, d.last_error
     FROM deliveries d JOIN endpoints p ON p.id = d.endpoint_id
     WHERE d.event_id = $1`,
    [eventId],
  );
  const names = Object.keys(ENDPOINTS);
  return Object.fromEntries(rows.map((row) => [names.find((n) => ENDPOINTS[n] === row.url), row]));
}

// Webhooks the receiver got for this run, with the endpoint name they were sent to.
async function received(type) {
  const all = await (await fetch(`${RECEIVER}/received`)).json();
  return all
    .filter((r) => JSON.parse(r.body).type === type)
    .map((r) => ({ ...r, name: r.path.slice(1), id: JSON.parse(r.body).id }));
}

// Wait until the API answers.
for (let i = 0; ; i++) {
  try { await fetch(API); break; } catch (error) {
    if (i === 30) throw error;
    await sleep(1000);
  }
}

// A new event type per run, so runs never mix.
const type = `demo.${Date.now()}`;
const secrets = {};
for (const [name, url] of Object.entries(ENDPOINTS)) {
  secrets[name] = (await post('/endpoints', { url, eventTypes: [type] })).signingSecret;
}
const { eventId, deliveryCount } = await post('/events', { type, payload: { text: 'hello' } });
console.log(`Published one event to ${deliveryCount} endpoints: ${Object.keys(ENDPOINTS).join(', ')}\n`);

await sleep(2000);
console.log('After 2 seconds:');
const early = await states(eventId);
check((await received(type)).some((r) => r.name === 'ok'), 'ok already has its webhook');
check(['fail', 'slow', 'down'].every((n) => early[n].state === 'pending'),
  'fail, slow and down are still being retried, and they did not hold ok up');

console.log('\nWaiting for the retries to finish (about 40 s)...');
for (let i = 0; i < 120 && Object.values(await states(eventId)).some((d) => d.state === 'pending'); i++) {
  await sleep(1000);
}

const final = await states(eventId);
console.log('\nFinal state of each delivery:');
for (const name of Object.keys(ENDPOINTS)) {
  const d = final[name];
  console.log(`  ${name.padEnd(6)} ${d.state.padEnd(10)} attempts: ${d.attempts}  ${d.last_error ?? ''}`);
}

console.log('\nChecks:');
const dead = (name, error) => final[name].state === 'dead' && final[name].attempts === 5 && final[name].last_error === error;
check(final.ok.state === 'delivered' && final.ok.attempts === 1, 'ok: delivered on the first try');
const all = await received(type);
const flaky = all.filter((r) => r.name === 'flaky');
check(final.flaky.state === 'delivered' && flaky.length === 3 && new Set(flaky.map((r) => r.id)).size === 1,
  'flaky: delivered on try 3, with the same id every time');
check(dead('fail', 'HTTP 500'), 'fail: dead (the DLQ) after 5 tries, reason HTTP 500');
check(dead('slow', 'timeout'), 'slow: dead after 5 tries, reason timeout');
check(dead('down', 'ECONNREFUSED'), 'down: dead after 5 tries, reason ECONNREFUSED');

check(all.every((r) => verify(secrets[r.name], r.timestamp, r.body, r.signature)),
  `all ${all.length} webhooks the receiver got have a valid signature`);
const sample = all.find((r) => r.name === 'ok');
check(!verify(secrets.ok, sample.timestamp, sample.body.replace('hello', 'HACKED'), sample.signature),
  'a changed body fails the signature check');
check(!verify(secrets.fail, sample.timestamp, sample.body, sample.signature),
  'the wrong secret fails the signature check');
const oldTimestamp = String(Number(sample.timestamp) - 600);
check(!verify(secrets.ok, oldTimestamp, sample.body, sign(secrets.ok, oldTimestamp, sample.body)),
  'a correctly signed webhook that is 10 minutes old is rejected');

await db.end();
console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
