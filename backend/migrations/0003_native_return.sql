-- A native sign-in returns to the app that started it: the callback redirects the browser to the
-- app's loopback port with a handoff, and the session is collected with the claim and the handoff together

-- Attempts live 600 seconds; none started before this migration can finish
DELETE FROM sign_in_attempts;

ALTER TABLE sign_in_attempts
  -- Where the browser is sent after the provider, on the device that ran it
  ADD COLUMN loopback_port INT CHECK (loopback_port BETWEEN 1024 AND 65535),
  -- SHA-256 of the secret the browser carries back to the app
  ADD COLUMN handoff_hash BYTEA,
  ADD CHECK ((client = 'native') = (loopback_port IS NOT NULL)),
  -- A web attempt is deleted when it signs in, so only a native one is ever signed in, and then it has its handoff
  ADD CHECK ((client = 'native' AND status = 'signed_in') = (handoff_hash IS NOT NULL)),
  ADD CHECK (client = 'native' OR status <> 'signed_in');
