-- One value per lane in src/lanes.ts; each kind is added with ALTER TYPE when its lane is
CREATE TYPE job_kind AS ENUM ();

-- The live statuses only: succeeded, failed and cancelled delete the row
CREATE TYPE job_status AS ENUM (
  'scheduled',
  'ready',
  'running',
  'waiting_for_approval',
  'waiting_for_event',
  'paused'
);

CREATE TABLE jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  kind job_kind NOT NULL,
  status job_status NOT NULL,
  -- Claimable from this instant when scheduled or ready
  due_at TIMESTAMPTZ NOT NULL,
  -- Claims made so far; a finish from an older claim changes nothing
  attempt INT NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  -- The kind's payload as a protobuf message
  payload BYTEA NOT NULL,
  CHECK ((status = 'running') = (lease_until IS NOT NULL))
);

CREATE INDEX ON jobs (kind, due_at, id) WHERE status IN ('scheduled', 'ready');
CREATE INDEX ON jobs (lease_until) WHERE status = 'running';
CREATE INDEX ON jobs (user_id);
