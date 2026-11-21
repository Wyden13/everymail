-- How a finished agent run ended; one value per finished target in src/job.ts
CREATE TYPE run_outcome AS ENUM ('succeeded', 'failed', 'cancelled');

-- Finished agent runs only: a live run is its jobs row, and keeps that row's id here
CREATE TABLE run_log (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  kind job_kind NOT NULL,
  outcome run_outcome NOT NULL,
  -- The claim that finished the run
  attempt INT NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The job's payload as it was when the run finished
  payload BYTEA NOT NULL
);

CREATE INDEX ON run_log (user_id, finished_at DESC);
CREATE INDEX ON run_log (finished_at);
