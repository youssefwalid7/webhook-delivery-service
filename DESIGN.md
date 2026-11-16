# Webhook Delivery Service

## Design and assumptions

The API registers endpoints by URL and event type and generates a signing secret for each endpoint. Publishing inserts the event and one delivery per matching subscription in a single Postgres transaction. The API returns 202 after commit. Subscriptions are evaluated when the fan-out insert runs. The prototype assumes a trusted publisher, immutable endpoint registrations and a 128 KB JSON request limit. Local HTTP is allowed for the Compose demo.

I used Postgres as both storage and queue. One transaction makes the event and its deliveries durable together. A partial index finds due deliveries, and the delivery rows also hold retry times and terminal outcomes. This keeps the prototype small at the cost of write volume and contention as load grows.

## Delivery and failure behavior

- **Claim.** Each of ten worker loops claims up to 50 due rows with `FOR UPDATE SKIP LOCKED`. It increments each attempt counter and hides the row for 30 seconds. A later claim changes the counter, so a stale worker cannot overwrite the new result.
- **Send.** Each batch sends its requests in parallel with a five-second timeout. Only a 2xx from the registered URL counts as success. Other responses, including redirects, and network failures use the retry path. Demo waits are 1, 2, 4 and 8 seconds. Exhausted deliveries are marked `dead` with a reason.
- **Slow or offline endpoint.** A slow request can occupy a slot for five seconds. Other requests can run alongside it while slots are free. In a saturation test, one endpoint filled all 500 slots, delaying a healthy delivery by 4.7 seconds. Results are saved together per batch, so a successful response can precede its recorded status.
- **Worker or database failure.** Work becomes eligible again after the 30-second visibility timeout if its result was never saved. A crash can consume an attempt before any HTTP request goes out. If the database is unreachable, the API cannot acknowledge new work and workers resume polling as connectivity returns. Committed work survives a process restart with the database volume intact.

## Guarantees and receiver contract

I provide durable queueing with bounded retries. A timeout or a crash after the receiver processes a request can cause a duplicate. Delivery may still end in `dead`, and ordering, latency targets and replay are outside the prototype. Retrying a publish after losing its response can create a second event.

Each POST has a stable delivery `id` and an HMAC-SHA256 signature over the Unix timestamp, a dot and the exact request body, using the endpoint's secret. Receivers should compare signatures in constant time, accept timestamps within five minutes of their clock, and deduplicate by delivery ID. Timestamp checks limit the replay window. Receivers should return 2xx after durably accepting the work.

## Scale and next steps

The target is 5,000 events per second across 50,000 endpoints. At an assumed ten subscribers per event, the system would enqueue 50,000 deliveries per second before retries. Holding that peak all day would create 4.32 billion delivery rows. The load depends heavily on how subscriptions are distributed and how long receivers take to respond.

Separate laptop tests measured roughly 2,500 publishes per second with three subscribers per event, and roughly 6,100 deliveries per second with one worker or 7,763 with three workers against a fast receiver. Publishing one event to 50,000 subscribers took about 1.5 seconds. These tests isolate publishing and delivery, so I would measure them together under representative fan-out, latency and failure rates before sizing production. See [TESTING.md](TESTING.md) for the setup and results.

1. **Move fan-out off the request path.** Commit the event and a durable fan-out task before returning 202. Record the subscription version that applies to the event. Expand recipients in chunks, updating the cursor in the same transaction as each chunk and using the unique event and endpoint pair to make retries safe.
2. **Protect capacity.** Enforce per-endpoint concurrency limits across workers and reserve capacity for fresh deliveries. Add a circuit breaker for failed endpoints. Use retry delays spread over roughly three days, with jitter and support for `Retry-After`. Track the age of the oldest due delivery and reject new work when the backlog exceeds capacity.
3. **Control storage and recovery.** Each successful delivery currently costs an insert and two updates. Set retention for terminal deliveries and keep pending work until it is resolved. Add delivery status, dead-letter replay and publish idempotency before expanding operational use.

## Scope choices

I kept the retry schedule, claiming and signing in the service. A separate broker adds an operational dependency and a second write path. I would revisit it if the measured Postgres write and retention limits warrant it. Strict ordering would let a failed event hold up later events for an endpoint. Exactly-once effects require receiver-side deduplication because a successful request can lose its response.

For public deployment I would require HTTPS, authenticate the API, protect stored secrets and enforce outbound network restrictions. Those controls are outside the local exercise.
