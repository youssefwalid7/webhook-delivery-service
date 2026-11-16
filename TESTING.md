# Test log

What we tested, how, and what happened. New tests are added at the bottom as the project grows.

**Machine:** Apple M4 MacBook, Docker Desktop with 10 CPUs and about 8 GB of memory, Postgres 16, Node 24.
Speed numbers come from this laptop, not a real server.

## Summary

| # | Test | Result |
|---|---|---|
| 1 | Register and publish | ✅ An event creates one to-do row per subscriber |
| 2 | Retry columns and the claim query | ✅ A worker takes a due row and hides it for 30 s |
| 3 | Which URLs we accept | ✅ http and https accepted, junk rejected |
| 4 | Burst of 10,000 events | ✅ About 2,500 events per second, 0 failures |
| 5 | One event with 50,000 subscribers | ⚠️ Works, but takes 1.5 s per event |
| 6 | Worker: one event, five kinds of endpoint | ✅ Healthy endpoint done at once; broken ones retried, then `dead` |
| 7 | Retries keep the same ID | ✅ Same ID 3 times, waits of 1 s then 2 s |
| 8 | Signature | ✅ Real body matches; a changed body or wrong key does not |
| 9 | Worker crashes while sending | ✅ The job came back 30 s later with the same ID |
| 10 | Sending speed, 1 worker vs 3 | ⚠️ About 2,400 per second; more workers didn't help, Postgres is the limit |

---

## 1. Register and publish

Commit `335ff8f` · 2026-11-16

**Goal:** an event creates exactly one to-do row (`deliveries`) for each endpoint subscribed to its type.

**Steps:** register endpoints A and B for `message.received` and C for `conversation.created`, then publish one `message.received` event.

| Check | Expected | Result |
|---|---|---|
| Publish response | 202 with `deliveryCount: 2` | ✅ |
| To-do rows | A and B are `pending`, nothing for C | ✅ |
| Event that nobody subscribes to | 202 with `deliveryCount: 0` | ✅ |
| Broken JSON | 400 | ✅ |

## 2. Retry columns and the claim query

Commit `67d1e79` · 2026-11-16

**Goal:** the worker's "take one job" query works with the new columns.

**Steps:** create two to-do rows, one due now and one waiting for a retry in 5 minutes. Run the claim query twice.

| Check | Expected | Result |
|---|---|---|
| First claim | Takes the due row, `attempts = 1`, hidden for 30 s | ✅ |
| Second claim | Finds nothing: one row is hidden, the other is not due | ✅ |
| Set `state` to `processing` | Rejected: only `pending`, `delivered`, `dead` | ✅ |
| Query plan | Uses the `deliveries_due` index | ✅ |

## 3. Which URLs we accept

Commit `dcc91ba` · 2026-11-16

| URL sent to `POST /endpoints` | Expected | Result |
|---|---|---|
| `http://receiver:4000/ok` | 201 | ✅ (was 400 before this commit) |
| `https://shop.example/hook` | 201 | ✅ |
| `ftp://files.example` | 400 | ✅ |
| `not a url` | 400 | ✅ |
| No URL | 400 | ✅ |

## 4. Burst of 10,000 events

Commit `dcc91ba` · 2026-11-16 · API only, no worker yet

**Goal:** see what happens when the platform sends thousands of events at the same time.

**Steps:** subscribe 3 endpoints to `message.received`, so each event saves 1 event row and 3 to-do rows. Send 10,000 events with ApacheBench (`ab`, included with macOS):

```sh
echo '{"type":"message.received","payload":{"messageId":"msg_1","text":"hello"}}' > event.json
ab -n 10000 -c 100 -p event.json -T application/json http://127.0.0.1:3000/events
```

`-n` is the total number of requests and `-c` is how many are sent at the same time.

| Sent at the same time | Events per second | Failed | Typical wait | 99% done within | Slowest |
|---|---|---|---|---|---|
| 100 | 2,523 | 0 | 36 ms | 85 ms | 0.14 s |
| 1,000 | 2,394 | 0 | 207 ms | 2.1 s | 3.1 s |

All 20,000 events and 60,000 to-do rows were saved. Postgres had 10 connections open from the API, out of 100 allowed.

**What it means:** sending 10 times more at once did not change the speed (about 2,400 per second). Only the wait grew. Requests wait in line for one of the API's 10 database connections (the connection pool), so Postgres is never flooded.

## 5. One event with 50,000 subscribers

Commit `dcc91ba` · 2026-11-16

**Goal:** check the assignment's number of endpoints, all subscribed to the same event type.

**Steps:** add 50,000 endpoints subscribed to `conversation.created` directly with SQL, to save time. Publish one event, three times.

| Run | To-do rows created | Time |
|---|---|---|
| 1 | 50,000 | 1.56 s |
| 2 | 50,000 | 1.53 s |
| 3 | 50,000 | 1.55 s |

**What it means:** it works, but each event like this holds one of the 10 database connections for 1.5 s. Ten at once would block all of them. At scale: answer 202 first, then create the to-do rows afterwards in chunks.

---

## Worker tests (6–10)

Commit `4b3dd69` · 2026-11-16

**Setup for all worker tests:** a temporary test server (not committed) with these paths:

| Path | Behaves like |
|---|---|
| `/ok` | A healthy endpoint: answers 200 |
| `/fail` | A broken endpoint: answers 500 |
| `/slow` | A slow endpoint: answers after 10 s, longer than our 5 s limit |
| `/flaky` | Fails twice for each delivery ID, then answers 200 |
| `http://sink:4999/down` | Offline: nothing is listening on that port |

Retry waits are 1, 2, 4 and 8 s, so 5 attempts in total. The real test receiver replaces this server in the next step.

## 6. Worker: one event, five kinds of endpoint

**Goal:** each delivery is handled on its own, so a broken endpoint does not hold up a healthy one.

**Steps:** subscribe all five to `message.received` and publish one event.

**2 seconds after publishing:**

| Endpoint | state | attempts | last_error |
|---|---|---|---|
| `/ok` | delivered | 1 | |
| `/flaky` | pending | 2 | HTTP 503 |
| `/fail` | pending | 2 | HTTP 500 |
| `/slow` | pending | 1 | (still waiting for an answer) |
| down | pending | 2 | ECONNREFUSED |

**41 seconds after publishing, everything finished:**

| Endpoint | state | attempts | last_error |
|---|---|---|---|
| `/ok` | delivered | 1 | |
| `/flaky` | delivered | 3 | |
| `/fail` | dead | 5 | HTTP 500 |
| `/slow` | dead | 5 | timeout |
| down | dead | 5 | ECONNREFUSED |

**What it means:** `/ok` was delivered at once while the others were still failing. Each to-do row is separate, so a broken endpoint only delays its own rows. Endpoints that never work end up `dead` (our DLQ), and the reason is saved.

## 7. Retries keep the same ID

What `/flaky` received:

| Time | Delivery ID | Answer |
|---|---|---|
| 16:09:31 | `92e998dc-…` | 503 |
| 16:09:32 (1 s later) | `92e998dc-…` | 503 |
| 16:09:34 (2 s later) | `92e998dc-…` | 200 |

**What it means:** the ID stays the same on every retry, so a receiver can use it to skip duplicates. The waits follow `RETRY_DELAYS`.

## 8. Signature

**Steps:** take the request `/ok` received and compute the signature again with the endpoint's secret key.

| Check | Expected | Result |
|---|---|---|
| Real body and the right secret | Match | ✅ Match |
| Body changed (`hello` → `HACKED`) | No match | ✅ No match |
| Wrong secret | No match | ✅ No match |

## 9. Worker crashes while sending

**Steps:** subscribe `/slow` to a new event type and publish. Kill the worker 1 s later, while it waits for the answer. Start it again.

| Check | Expected | Result |
|---|---|---|
| Row right after the kill | `pending`, 1 attempt, hidden for about 30 s | ✅ `pending`, 1 attempt, hidden 29 s |
| Job comes back | After 30 s, with the same ID | ✅ Sent at 16:10:43 and again at 16:11:13, same ID |

**What it means:** no recovery code is needed. The 30 s hide (the visibility timeout) brings the job back by itself. The first send may already have reached the endpoint, so the endpoint can get the same delivery twice. This is at-least-once delivery.

## 10. Sending speed, 1 worker vs 3

**Steps:** stop the worker, queue deliveries to `/ok`, start 1 or 3 workers, and time until nothing is pending. Times include about 1 s to start the containers.

| Deliveries | 1 worker | 3 workers |
|---|---|---|
| 5,000 | 3.6 s | 3.5 s |
| 20,000 | 8.4 s | 7.6 s |

**CPU while sending 20,000** (100% = one CPU core):

| Container | 1 worker | 3 workers |
|---|---|---|
| Postgres | 276% | 373% |
| Worker(s) | 120% | 87% + 76% + 78% |
| Test server | 31% | 38% |

**What it means:** about 2,400 deliveries per second. Three workers were barely faster. Postgres got busier while each worker got less busy, so the workers were waiting for the database. Postgres is the shared limit: every delivery is 2 writes, one to take the job and one to save the result. The first fix to try is taking many jobs per query instead of one.

---

## Still to test

- [x] The worker sends a signed webhook and the row becomes `delivered` (tests 6 and 8)
- [x] A failing endpoint is retried, then moved to `dead` (the DLQ) (test 6)
- [x] A slow or offline endpoint does not hold up healthy ones (test 6)
- [x] A worker that crashes mid-send: the job comes back after 30 s (test 9)
- [ ] The real test receiver checks signatures and skips duplicate IDs
- [ ] A crash during the **last** attempt ends as `dead` ("worker stopped during the last attempt")
- [ ] Taking 50 jobs per query instead of 1: does it beat 2,400 per second?
- [ ] Is the publish limit (about 2,500 per second) Node or Postgres? Run 2 API copies and compare
