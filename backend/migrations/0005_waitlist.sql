-- The landing page's waitlist form sends an email and nothing else.
-- The index is on lower(email), so one address in two spellings is one signup
CREATE TABLE waitlist (
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ON waitlist (lower(email));
