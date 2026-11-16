import { createHmac, timingSafeEqual } from 'node:crypto';

// Signs the timestamp and the exact body we send, using the endpoint's secret key.
export function sign(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// What a customer runs to check a webhook came from us: the signature must match
// and the timestamp must be less than 5 minutes old (so an old request can't be replayed).
export function verify(secret, timestamp, body, signature) {
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(String(signature));
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && expected.length === given.length && timingSafeEqual(expected, given);
}
