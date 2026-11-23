-- What a job of a kind other than an agent run concerns. A lane that keeps its subject marks it failed,
-- with the reason, when its job exhausts its retries (src/subjects.ts). Each table is minimal: the
-- account connect and send items add their other columns

-- One value per account status in TODO-backend; progress and synced time come with fetch
CREATE TYPE account_status AS ENUM ('syncing', 'synced', 'sign_in_expired', 'failed');

CREATE TABLE accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  status account_status NOT NULL DEFAULT 'syncing',
  -- Set exactly when the status is failed
  failure_reason failure_reason,
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL))
);

CREATE INDEX ON accounts (user_id);

-- The Backend's side of the engine's send state; queued lives only in the engine's offline queue
CREATE TYPE send_status AS ENUM ('undoable', 'scheduled', 'sending', 'sent', 'failed');

CREATE TABLE sends (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  account_id BIGINT NOT NULL REFERENCES accounts ON DELETE CASCADE,
  status send_status NOT NULL,
  -- Set exactly when the status is failed
  failure_reason failure_reason,
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL))
);

CREATE INDEX ON sends (user_id);
CREATE INDEX ON sends (account_id);
