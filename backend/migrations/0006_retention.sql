-- One repeating job per user deletes what is past its retention (src/retention.ts). The new value is
-- usable only once this transaction commits, so the job is ensured at boot and in each sign-in, not here
ALTER TYPE job_kind ADD VALUE 'retention';
