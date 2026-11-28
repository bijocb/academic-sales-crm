-- Hand-written. Separate migration because a new enum value cannot be used in the transaction that adds it.
-- A refunded admission no longer blocks a new admission for the lead.
DROP INDEX "admissions_one_live_per_lead";
CREATE UNIQUE INDEX "admissions_one_live_per_lead" ON "admissions"("lead_id") WHERE "status" NOT IN ('CANCELLED', 'CANCELLED_REFUNDED');
