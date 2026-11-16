import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import pg from 'pg';

const { DATABASE_URL, PORT = 3000 } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: DATABASE_URL });
pool.on('error', (error) => console.error('Idle database connection failed', error.code));

async function transaction(operation) {
  const client = await pool.connect();
  let discardConnection = false;

  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardConnection = true;
    }
    throw error;
  } finally {
    client.release(discardConnection);
  }
}

function validEventType(type) {
  return typeof type === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(type);
}

function parseEndpointUrl(value) {
  if (typeof value !== 'string') return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

const app = express();
app.use(express.json({ limit: '128kb' }));

app.post('/endpoints', async (req, res) => {
  const { url, eventTypes } = req.body ?? {};
  const endpointUrl = parseEndpointUrl(url);
  if (!endpointUrl || !Array.isArray(eventTypes) ||
      eventTypes.length === 0 || !eventTypes.every(validEventType)) {
    return res.status(400).json({ error: 'An HTTPS URL and nonempty eventTypes list are required' });
  }

  const endpointId = randomUUID();
  const signingSecret = randomBytes(32).toString('hex');
  await transaction(async (client) => {
    await client.query(
      'INSERT INTO endpoints (id, url, signing_secret) VALUES ($1, $2, $3)',
      [endpointId, endpointUrl, signingSecret],
    );
    await client.query(
      'INSERT INTO subscriptions (endpoint_id, event_type) SELECT $1, unnest($2::text[])',
      [endpointId, [...new Set(eventTypes)]],
    );
  });

  res.status(201).json({ endpointId, signingSecret });
});

app.post('/events', async (req, res) => {
  const { type, payload } = req.body ?? {};
  if (!validEventType(type) || payload === undefined) {
    return res.status(400).json({ error: 'A valid type and a JSON payload are required' });
  }

  const eventId = randomUUID();
  const deliveryCount = await transaction(async (client) => {
    await client.query(
      'INSERT INTO events (id, event_type, payload) VALUES ($1, $2, $3::jsonb)',
      [eventId, type, JSON.stringify(payload)],
    );
    const result = await client.query(
      `INSERT INTO deliveries (event_id, endpoint_id)
       SELECT $1, endpoint_id FROM subscriptions WHERE event_type = $2`,
      [eventId, type],
    );
    return result.rowCount;
  });

  res.status(202).json({ eventId, deliveryCount });
});

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }
  console.error('Request failed', error.code ?? error.name);
  res.status(500).json({ error: 'Could not complete the request' });
});

app.listen(Number(PORT), () => console.log(`API listening on port ${PORT}`));
