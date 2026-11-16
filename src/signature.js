import { createHmac } from 'node:crypto';

// Signs the timestamp and the exact body we send, using the endpoint's secret key.
// The worker uses this to sign; the test receiver uses it to check.
export function sign(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
