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

## Still to test

- [ ] The worker sends a signed webhook and the row becomes `delivered`
- [ ] A failing endpoint is retried, then moved to `dead` (the DLQ)
- [ ] A slow or offline endpoint does not hold up healthy ones
- [ ] A worker that crashes mid-send: the job comes back after 30 s
- [ ] Is the 2,500 per second limit Node or Postgres? Run 2 API copies and compare
