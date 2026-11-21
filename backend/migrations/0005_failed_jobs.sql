-- Why a job of a lane that does not log failed for good; one value per FailureReason in src/job.ts.
-- Each lane adds its own reasons with ALTER TYPE when its lane is
CREATE TYPE failure_reason AS ENUM ('timed_out', 'threw');

-- Jobs of lanes that do not log, deleted as failed: kept under the job's id with why
CREATE TABLE failed_jobs (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  kind job_kind NOT NULL,
  reason failure_reason NOT NULL,
  -- The claim that failed last
  attempt INT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The job's payload as it was when it failed
  payload BYTEA NOT NULL
);

CREATE INDEX ON failed_jobs (user_id, failed_at DESC);
CREATE INDEX ON failed_jobs (failed_at);
