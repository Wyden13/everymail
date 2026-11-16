CREATE TYPE sign_in_provider AS ENUM ('google', 'microsoft');

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  provider sign_in_provider NOT NULL,
  -- The OIDC `sub` claim
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE sessions (
  -- SHA-256 of the credential
  token_hash BYTEA PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
