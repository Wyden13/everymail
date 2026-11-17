CREATE TYPE sign_in_provider AS ENUM ('google', 'microsoft');

-- Picks the redirect URI and how the session credential is delivered: bearer for native, cookie for web
CREATE TYPE sign_in_client AS ENUM ('native', 'web');

-- denied: the user cancelled at the provider. failed: the code exchange or the ID token check failed
CREATE TYPE sign_in_status AS ENUM ('pending', 'signed_in', 'denied', 'failed');

CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider sign_in_provider NOT NULL,
  -- The OIDC `sub` claim
  subject TEXT NOT NULL,
  -- For display only; the user is (provider, subject)
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE sessions (
  -- SHA-256 of the credential
  token_hash BYTEA PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON sessions (user_id);

-- An OIDC sign-in from its authorize URL until the client collects the outcome, deleted then.
-- Global table: it exists before there is a user
CREATE TABLE sign_in_attempts (
  -- SHA-256 of the `state` parameter, which passes through the browser
  state_hash BYTEA PRIMARY KEY,
  -- SHA-256 of the secret only the native client holds, to collect the session with
  claim_hash BYTEA NOT NULL UNIQUE,
  provider sign_in_provider NOT NULL,
  client sign_in_client NOT NULL,
  -- PKCE verifier, sent with the code exchange
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  status sign_in_status NOT NULL DEFAULT 'pending',
  user_id BIGINT REFERENCES users ON DELETE CASCADE,
  -- Covers both the callback and the collect
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK ((status = 'signed_in') = (user_id IS NOT NULL))
);
