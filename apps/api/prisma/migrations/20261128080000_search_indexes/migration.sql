-- Hand-written (Phase 15 load test): trigram indexes so lead search ("contains", case-insensitive) uses an index
-- instead of scanning every lead and person. Not expressible in schema.prisma; keep out of generated diffs.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "persons_full_name_trgm_idx" ON "persons" USING gin ("full_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "persons_email_trgm_idx" ON "persons" USING gin ("email" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "persons_phone_trgm_idx" ON "persons" USING gin ("phone_e164" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "leads_lead_number_trgm_idx" ON "leads" USING gin ("lead_number" gin_trgm_ops);
