# Webhook Delivery Service

An Express API and Postgres queue for signed outbound webhooks. The first milestone implements registration and durable fan-out. The next milestone will add the delivery worker and a test receiver.

## Run locally

```sh
docker compose up --build
```

The API is available at http://localhost:3000. Compose sets up the schema when it initializes a new database volume. This is a local prototype with development credentials and trusted callers.

## Try the first milestone

Register these three endpoints on a fresh instance:

```sh
curl -fsS http://localhost:3000/endpoints -H 'Content-Type: application/json' \
  -d '{"url":"https://a.example/webhooks","eventTypes":["message.received"]}'
curl -fsS http://localhost:3000/endpoints -H 'Content-Type: application/json' \
  -d '{"url":"https://b.example/webhooks","eventTypes":["message.received"]}'
curl -fsS http://localhost:3000/endpoints -H 'Content-Type: application/json' \
  -d '{"url":"https://c.example/webhooks","eventTypes":["conversation.created"]}'
```

Registration returns HTTP 201 and a per-endpoint signing secret. Publish an event:

```sh
curl -fsS -i http://localhost:3000/events -H 'Content-Type: application/json' \
  -d '{"type":"message.received","payload":{"messageId":"msg_1"}}'
```

Expect HTTP 202 and a response with an event ID and `"deliveryCount":2`. Inspect the queue:

```sh
docker compose exec db psql -U webhooks -d webhooks -c \
  'SELECT e.event_type, p.url, d.state FROM deliveries d JOIN events e ON e.id = d.event_id JOIN endpoints p ON p.id = d.endpoint_id ORDER BY p.url;'
```

The two matching URLs each have a pending delivery. Subscriptions are global by event type. Repeating the publish creates a new event. Repeating registration creates a new endpoint.

## Why these tables?

One event row stores the payload once. The subscription key begins with event type so Postgres can find matching endpoints. Each delivery row references an event and an endpoint. Storing one row per destination gives each endpoint an independent delivery state.

The publish route inserts the event and its delivery rows in one transaction and returns 202 after commit. A process crash after 202 leaves both rows available to a future worker. An error during fan-out rolls back the event as well. A lost response around commit can leave the publisher unsure whether its request was accepted.

## Next milestone

Have a worker claim one pending delivery and send it to a test receiver that verifies the signature. Once the happy path works, add timeouts, leases, bounded concurrency, and retry scheduling.
