CREATE TABLE endpoints (
    id uuid PRIMARY KEY,
    url text NOT NULL,
    signing_secret text NOT NULL
);

CREATE TABLE subscriptions (
    event_type text NOT NULL,
    endpoint_id uuid NOT NULL REFERENCES endpoints (id),
    PRIMARY KEY (event_type, endpoint_id)
);

CREATE TABLE events (
    id uuid PRIMARY KEY,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL REFERENCES events (id),
    endpoint_id uuid NOT NULL REFERENCES endpoints (id),
    state text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'delivered', 'dead')),
    attempts integer NOT NULL DEFAULT 0,
    -- When a worker may take this row: now for new rows, later for retries,
    -- and 30s ahead while a worker is sending it (visibility timeout).
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error text,
    UNIQUE (event_id, endpoint_id)
);

-- Serves the worker's claim query: pending rows that are due, oldest first.
CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE state = 'pending';
