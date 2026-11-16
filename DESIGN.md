# Design: Webhook Delivery Service

The API saves each event, plus one to-do row per subscribed endpoint, in a single Postgres transaction. Workers take due rows, send signed POSTs, and retry with growing waits until each row is `delivered` or `dead`. Measured results are in [TESTING.md](TESTING.md).

## How it works

1. **Register** (`POST /endpoints`): saves the URL and its event types, and returns a random signing secret.
2. **Publish** (`POST /events`): one transaction inserts the event and a `deliveries` row for each subscribed endpoint. Answers 202 after the commit.
3. **Take**: each worker loop takes up to 50 due `pending` rows (`FOR UPDATE SKIP LOCKED`). It adds 1 to `attempts` and moves `next_attempt_at` 30 s ahead, which hides the rows while they are sent (a visibility timeout).
4. **Send**: the whole batch at once, signed, with a 5 s limit per request.
5. **Save**: one statement per batch. A 2xx answer makes the row `delivered`. A failure with tries left sets a later `next_attempt_at`. No tries left makes the row `dead` (our dead-letter queue), with the reason in `last_error`.

**Why a Postgres table is the queue:** the event and its jobs are saved in one transaction, so a crash can't save one without the other. Delayed retries and the visibility timeout are one column. Status is a SQL query. A backlog from a days-long outage sits on disk, not in memory. The cost is write volume (see Scale).

## Delivery guarantees

**We provide:**
- **202 means saved:** the event and its deliveries survive a crash right after the answer.
- **At-least-once delivery:** each delivery is attempted until it gets a 2xx or becomes `dead`, with the last error kept.
- **Signed webhooks:** each one is signed with its endpoint's secret and carries an `id` that stays the same on every retry.

**We do not provide:**
- **Exactly once.** A worker crash after sending, or a receiver answering after 5 s, causes a resend. Receivers skip `id`s they have already seen.
- **Ordering**, a delivery-time target, or delivery after the retries run out (there is no replay yet).
- **Safe publish retries.** Resending a publish whose 202 was lost creates a second event.

**Rules for receivers:** the body is `{ id, type, createdAt, data }`. `Webhook-Signature` is the hex HMAC-SHA256 of `Webhook-Timestamp + "." + raw body`, using the endpoint's secret. To verify, compute it yourself and compare in constant time. Reject timestamps older than 5 minutes, which stops replays. Answer 2xx within 5 s and do slow work afterwards.

## When things go wrong

| Situation | What happens |
|---|---|
| Endpoint slow | The attempt stops at 5 s and is retried later. Each delivery is its own row, so healthy endpoints are still served at once (test 6). |
| Endpoint failing or down | Retried after 1, 2, 4 and 8 s (demo values), then `dead`. Production waits would be 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h and 24 h: about 3 days in total. |
| Worker crashes | Its rows reappear after 30 s and any worker takes them (test 9). Attempts are counted when a job is taken, so a job that keeps crashing workers still ends `dead`. |
| Several workers | `SKIP LOCKED` means no two workers take the same row. A late result for a row that was taken again is ignored, because `attempts` no longer matches. |
| Postgres down | Publish answers 500, so the platform retries. Workers retry every second. Accepted work is not lost, and a send whose result wasn't saved is sent again. |
| Burst of events | Requests queue for 10 database connections. 1,000 requests at once all succeeded at about 2,500 events/s (test 4). Only the wait grows. |

## Assumptions

- Subscriptions are by event type only. There are no customer accounts or authentication, and the publishing platform is trusted.
- Only endpoints subscribed at publish time receive an event. Endpoints can't be edited or deleted.
- Payloads are JSON, up to 128 KB. Success means a 2xx answer within 5 s.
- Runs locally only, so http URLs are allowed and retry waits are in seconds.

## Scale: 5,000 events/s across 50,000 endpoints

**Measured on a laptop:** about 2,500 published events/s. Sending reached 6,100 deliveries/s per worker after batching (2,455 before), and 7,763/s with 3 workers. One event to 50,000 subscribers took 1.5 s.

At 10 subscribers per event, the target is 50,000 deliveries/s, about 10 times what we measured. The system would fall behind but not lose data. The limits, in order:
1. **Postgres write volume.** Each delivery is 1 insert and 2 updates, and each update leaves an old row copy for autovacuum to clean.
2. **Table growth.** About 4.3 billion rows a day.
3. **Big fan-outs.** They hold database connections while they run.
4. **Dead endpoints.** Their retries take up sending capacity.

**What I would change, in order:**
1. **Give Postgres less work.** Batching is done (2.5 times faster). Next: save only the event before answering 202 and create delivery rows afterwards in chunks. Use one `deliveries` table per day and drop old days. Add PgBouncer. Scale workers on the age of the oldest due row.
2. **Isolate bad endpoints.** Pause an endpoint after repeated failures and test it with single requests (a circuit breaker). Give slow endpoints their own worker pool.
3. **For millions per second,** move the busy path to Kafka, partitioned by endpoint. Only failures go to a Postgres retry table, because most webhooks succeed on the first try.

## Next, with more time

- Replay `dead` deliveries, and a delivery-status API for customers.
- Production retry waits with random jitter, and honoring `Retry-After` on 429 and 503.
- Answer 503 when a database connection takes more than 2 s to get (backpressure).
- Save each result as soon as it is known. Saving per batch delays the stored status by up to 5 s (test 12).
- A limit on how many requests go to one endpoint at the same time.
- An idempotency key for publishing, plus editing and deleting endpoints and rotating secrets.

## What I chose not to do, and why

- **No message broker** (RabbitMQ, Kafka, Redis, SQS). Postgres was enough and keeps the event and its jobs in one transaction. A broker is the scale step.
- **No job library** (BullMQ and similar). The assignment asks for our own retry and backoff, and theirs would have to be switched off.
- **No ordering.** It would mean one delivery at a time per endpoint, and one failing event would block the rest.
- **No exactly-once delivery.** It isn't possible over HTTP. At-least-once with a stable `id` is the standard approach.
- **No production hardening:** https, authentication, encrypted secrets, and blocking URLs or redirects that point at internal servers. The service is local-only, so these come before real use.
