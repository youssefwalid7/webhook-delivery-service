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
    state text NOT NULL DEFAULT 'pending',
    UNIQUE (event_id, endpoint_id)
);
