-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('OPEN', 'MERGED', 'DISMISSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EnquiryClassification" ADD VALUE 'EXISTING_PERSON';
ALTER TYPE "EnquiryClassification" ADD VALUE 'CROSS_CHANNEL_DUPLICATE';

-- AlterEnum
ALTER TYPE "LeadStatus" ADD VALUE 'MERGED';

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "merged_into_lead_id" UUID;

-- AlterTable
ALTER TABLE "persons" ADD COLUMN     "merged_at" TIMESTAMPTZ(3),
ADD COLUMN     "merged_into_id" UUID,
ADD COLUMN     "name_key" TEXT;

-- CreateTable
CREATE TABLE "duplicate_candidates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "person_a_id" UUID NOT NULL,
    "person_b_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reasons" TEXT[],
    "status" "CandidateStatus" NOT NULL DEFAULT 'OPEN',
    "detected_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" UUID,
    "resolution_note" TEXT,

    CONSTRAINT "duplicate_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_merges" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "survivor_id" UUID NOT NULL,
    "merged_id" UUID NOT NULL,
    "candidate_id" UUID,
    "field_choices" JSONB NOT NULL,
    "lead_plan" JSONB NOT NULL,
    "survivor_before" JSONB NOT NULL,
    "merged_before" JSONB NOT NULL,
    "note" TEXT,
    "merged_by_id" UUID NOT NULL,
    "merged_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "person_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "body" TEXT,
    "data" JSONB,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "duplicate_candidates_organization_id_status_score_idx" ON "duplicate_candidates"("organization_id", "status", "score");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_candidates_person_a_id_person_b_id_key" ON "duplicate_candidates"("person_a_id", "person_b_id");

-- CreateIndex
CREATE INDEX "person_merges_organization_id_survivor_id_idx" ON "person_merges"("organization_id", "survivor_id");

-- CreateIndex
CREATE INDEX "lead_events_organization_id_lead_id_occurred_at_idx" ON "lead_events"("organization_id", "lead_id", "occurred_at");

-- CreateIndex
CREATE INDEX "persons_organization_id_name_key_idx" ON "persons"("organization_id", "name_key");


-- =====================================================================
-- Hand-written: merge-aware uniqueness, append-only history, grants, RLS.
-- =====================================================================
-- A merged person keeps its phone for history; uniqueness applies to active people only.
DROP INDEX "persons_org_phone_uq";
CREATE UNIQUE INDEX "persons_org_phone_uq" ON "persons" ("organization_id", "phone_e164")
  WHERE "phone_e164" IS NOT NULL AND "merged_into_id" IS NULL;
CREATE INDEX "persons_org_phone_prefix_idx" ON "persons" ("organization_id", "phone_e164" text_pattern_ops);
ALTER TABLE "persons" ADD CONSTRAINT "persons_not_self_merged_chk" CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id");
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_order_chk" CHECK ("person_a_id" < "person_b_id");

CREATE TRIGGER person_merges_append_only BEFORE UPDATE OR DELETE ON "person_merges"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER lead_events_append_only BEFORE UPDATE OR DELETE ON "lead_events"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON "duplicate_candidates" TO crm_app;
GRANT SELECT, INSERT ON "person_merges", "lead_events" TO crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "person_merges", "lead_events" FROM crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['duplicate_candidates','person_merges','lead_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
