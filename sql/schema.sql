CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS system_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  committed_revision bigint NOT NULL DEFAULT 0 CHECK (committed_revision >= 0)
);

INSERT INTO system_state (singleton, committed_revision)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS accounts (
  account_id uuid PRIMARY KEY,
  owner_fingerprint text NOT NULL UNIQUE CHECK (length(owner_fingerprint) = 64),
  version_id uuid NOT NULL UNIQUE,
  committed_revision bigint NOT NULL CHECK (committed_revision > 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS sharing_policies (
  account_id uuid PRIMARY KEY REFERENCES accounts(account_id),
  enabled boolean NOT NULL,
  version_id uuid NOT NULL UNIQUE,
  version_number integer NOT NULL CHECK (version_number > 0),
  committed_revision bigint NOT NULL CHECK (committed_revision > 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS relationship_edges (
  owner_account_id uuid NOT NULL REFERENCES accounts(account_id),
  other_account_id uuid NOT NULL REFERENCES accounts(account_id),
  state text NOT NULL CHECK (state IN ('accepted', 'revoked', 'blocked')),
  version_id uuid NOT NULL UNIQUE,
  version_number integer NOT NULL CHECK (version_number > 0),
  committed_revision bigint NOT NULL CHECK (committed_revision > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_account_id, other_account_id),
  CHECK (owner_account_id <> other_account_id)
);

CREATE INDEX IF NOT EXISTS relationship_edges_reverse
  ON relationship_edges (other_account_id, owner_account_id, state);

CREATE TABLE IF NOT EXISTS device_generations (
  account_id uuid PRIMARY KEY REFERENCES accounts(account_id),
  generation_id uuid NOT NULL UNIQUE,
  generation_number integer NOT NULL CHECK (generation_number > 0),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  committed_revision bigint NOT NULL CHECK (committed_revision > 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS presences (
  account_id uuid PRIMARY KEY REFERENCES accounts(account_id),
  generation_id uuid NOT NULL REFERENCES device_generations(generation_id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  location_epoch uuid NOT NULL UNIQUE,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude >= -180 AND longitude < 180),
  location geography(Point, 4326) NOT NULL,
  accepted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > accepted_at),
  committed_revision bigint NOT NULL CHECK (committed_revision > 0)
);

CREATE INDEX IF NOT EXISTS presences_location_gist ON presences USING gist (location);
CREATE INDEX IF NOT EXISTS presences_expiry ON presences (expires_at);

CREATE TABLE IF NOT EXISTS mutation_requests (
  owner_fingerprint text NOT NULL CHECK (length(owner_fingerprint) = 64),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  intent_digest text NOT NULL CHECK (length(intent_digest) = 64),
  operation text NOT NULL CHECK (operation IN (
    'account_create', 'relationship_set', 'policy_set', 'device_rotate', 'location_update'
  )),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'precondition_failed')),
  http_status integer NOT NULL CHECK (http_status BETWEEN 200 AND 499),
  result_revision bigint,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_fingerprint, request_key),
  CHECK (
    (outcome = 'applied' AND result_revision IS NOT NULL AND result_revision > 0)
    OR (outcome = 'precondition_failed' AND result_revision IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS nearby_sessions (
  session_id uuid PRIMARY KEY,
  viewer_account_id uuid NOT NULL REFERENCES accounts(account_id),
  owner_fingerprint text NOT NULL CHECK (length(owner_fingerprint) = 64),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  intent_digest text NOT NULL CHECK (length(intent_digest) = 64),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude >= -180 AND longitude < 180),
  center geography(Point, 4326) NOT NULL,
  radius_meters integer NOT NULL CHECK (radius_meters BETWEEN 1 AND 50000),
  max_results integer NOT NULL CHECK (max_results BETWEEN 1 AND 100),
  initial_revision bigint NOT NULL CHECK (initial_revision >= 0),
  last_event_sequence bigint NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  retained_from_sequence bigint NOT NULL DEFAULT 1 CHECK (retained_from_sequence > 0),
  event_retention integer NOT NULL CHECK (event_retention BETWEEN 1 AND 128),
  wake_channel text NOT NULL UNIQUE CHECK (length(wake_channel) BETWEEN 32 AND 128),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  UNIQUE (viewer_account_id, request_key)
);

CREATE INDEX IF NOT EXISTS nearby_sessions_viewer_expiry
  ON nearby_sessions (viewer_account_id, expires_at);

CREATE TABLE IF NOT EXISTS nearby_session_events (
  session_id uuid NOT NULL REFERENCES nearby_sessions(session_id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  committed_revision bigint NOT NULL CHECK (committed_revision > 0),
  event_type text NOT NULL CHECK (event_type = 'refresh_required'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, sequence)
);

CREATE TABLE IF NOT EXISTS wake_outbox (
  outbox_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES nearby_sessions(session_id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  state text NOT NULL CHECK (state IN ('pending', 'claimed', 'sent')),
  claim_token uuid,
  lease_until timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  created_at timestamptz NOT NULL,
  sent_at timestamptz,
  UNIQUE (session_id, sequence),
  CHECK (
    (state = 'pending' AND claim_token IS NULL AND lease_until IS NULL AND sent_at IS NULL)
    OR (state = 'claimed' AND claim_token IS NOT NULL AND lease_until IS NOT NULL AND sent_at IS NULL)
    OR (state = 'sent' AND claim_token IS NULL AND lease_until IS NULL AND sent_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS wake_outbox_work
  ON wake_outbox (state, lease_until, created_at)
  WHERE state <> 'sent';
