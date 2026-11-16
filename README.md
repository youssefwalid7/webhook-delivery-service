# Webhook Delivery Service

Customers register an endpoint (a URL plus the event types they want). The platform publishes events, and the service delivers each event to every subscribed endpoint. Each request is signed, with retries and a dead-letter state. It's built with Node, Express and Postgres, and a Postgres table is the queue.

- **Design** — [Two-page PDF](DESIGN.pdf) · [Markdown](DESIGN.md)
- **[TESTING.md](TESTING.md)**: every test I ran, with measured results.

## Run it

```sh
docker compose up --build
```

This starts Postgres, the API (http://localhost:3000), the delivery worker, and a test receiver. The database schema is created the first time the volume is created. To start from scratch, run `docker compose down -v`.

## See it work

In a second terminal:

```sh
docker compose run --rm demo
```

The demo registers five endpoints on the test receiver: `ok`, `fail` (500), `slow` (10 s, past the 5 s limit), `flaky` (fails twice, then works) and `down` (nothing listening). It publishes one event to all five and checks the results. That takes about 45 seconds:

- `ok` gets its webhook at once, while the others are still being retried.
- `flaky` is delivered on its 3rd try, with the same delivery `id` each time.
- `fail`, `slow` and `down` end up `dead` after 5 tries, and each one keeps its reason.
- Every webhook has a valid signature. A changed body, a wrong secret, or a 10-minute-old timestamp all fail the check.

The script exits with 0 when every check passes.

## API

```sh
# Register an endpoint. The answer includes its signing secret.
curl -s localhost:3000/endpoints -H 'Content-Type: application/json' \
  -d '{"url":"http://receiver:4000/ok","eventTypes":["message.received"]}'

# Publish an event. The answer is 202 with the number of deliveries created.
curl -s localhost:3000/events -H 'Content-Type: application/json' \
  -d '{"type":"message.received","payload":{"messageId":"msg_1"}}'
```

To see the queue:

```sh
docker compose exec db psql -U webhooks -d webhooks -c \
  'SELECT p.url, d.state, d.attempts, d.last_error FROM deliveries d JOIN endpoints p ON p.id = d.endpoint_id'
```

## Verifying a webhook (for receivers)

Each delivery is a `POST` with the JSON body `{ id, type, createdAt, data }` and two headers:

- `Webhook-Timestamp`: Unix seconds.
- `Webhook-Signature`: hex HMAC-SHA256 of `timestamp + "." + raw body`, computed with the endpoint's secret.

To verify one, compute the signature yourself and compare in constant time. Accept timestamps within 5 minutes of your clock. [`verify()` in src/signature.js](src/signature.js) does exactly this.

Answer with a 2xx within 5 s after durably accepting the work. Redirects and other failures use the retry budget. The same `id` can arrive more than once, so deduplicate by delivery ID.

## Files

| File | What it does |
|---|---|
| `db/schema.sql` | Tables: `endpoints`, `subscriptions`, `events`, `deliveries` (the queue) |
| `src/server.js` | API: `POST /endpoints`, `POST /events` |
| `src/worker.js` | Takes due deliveries in batches, sends them signed, retries, and marks them `delivered` or `dead` |
| `src/signature.js` | `sign()` used by the worker; `verify()` for receivers |
| `src/receiver.js` | Test receiver: `/ok`, `/fail`, `/slow`, `/flaky` |
| `scripts/demo.js` | The demo and its checks |

Worker settings (batch size, timeout, retry waits) are constants at the top of `src/worker.js`. The retry waits are short (1, 2, 4, 8 s) so the demo finishes quickly. The design describes the proposed production retry window.
