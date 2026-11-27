-- CreateEnum
CREATE TYPE "InterestLevel" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('OPEN', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'EXPIRED');

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "stage_changed_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "lead_stage_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "from_stage" TEXT NOT NULL,
    "to_stage" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "actor_user_id" UUID,
    "reason" TEXT,
    "snapshot" JSONB,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_qualifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "highest_qualification" TEXT,
    "eligibility_notes" TEXT,
    "requirement" TEXT,
    "interest_level" "InterestLevel",
    "preferred_course_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "intake" TEXT,
    "fee_readiness" TEXT,
    "objections" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "course_id" UUID NOT NULL,
    "batch_id" UUID,
    "currency" "Currency" NOT NULL,
    "list_fee_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,
    "discount_reason" TEXT,
    "notes" TEXT,
    "valid_until" DATE NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'OPEN',
    "decision_reason" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "page" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_stage_history_organization_id_lead_id_occurred_at_idx" ON "lead_stage_history"("organization_id", "lead_id", "occurred_at");

-- CreateIndex
CREATE INDEX "lead_stage_history_organization_id_brand_id_to_stage_occurr_idx" ON "lead_stage_history"("organization_id", "brand_id", "to_stage", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_qualifications_lead_id_key" ON "lead_qualifications"("lead_id");

-- CreateIndex
CREATE INDEX "quotations_organization_id_lead_id_created_at_idx" ON "quotations"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organization_id_number_key" ON "quotations"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "saved_views_user_id_page_name_key" ON "saved_views"("user_id", "page", "name");


-- =====================================================================
-- Hand-written: integrity, append-only history, grants, RLS.
-- =====================================================================
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_direction_chk" CHECK ("direction" IN ('FORWARD', 'BACKWARD'));
CREATE TRIGGER lead_stage_history_append_only BEFORE UPDATE OR DELETE ON "lead_stage_history"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "lead_qualifications" ADD CONSTRAINT "lead_qualifications_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "quotations" ADD CONSTRAINT "quotations_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_course_fkey" FOREIGN KEY ("organization_id", "course_id") REFERENCES "courses"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_amounts_chk" CHECK ("list_fee_minor" >= 0 AND "discount_minor" >= 0 AND "discount_minor" <= "list_fee_minor" AND "total_minor" = "list_fee_minor" - "discount_minor");
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_discount_reason_chk" CHECK ("discount_minor" = 0 OR "discount_reason" IS NOT NULL);
-- Amounts and offer terms are immutable once issued (only the decision fields change).
CREATE OR REPLACE FUNCTION crm_quotation_terms_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.course_id IS DISTINCT FROM OLD.course_id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.list_fee_minor <> OLD.list_fee_minor OR NEW.discount_minor <> OLD.discount_minor
     OR NEW.total_minor <> OLD.total_minor OR NEW.currency <> OLD.currency OR NEW.lead_id <> OLD.lead_id
     OR NEW.number <> OLD.number THEN
    RAISE EXCEPTION 'quotation terms are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER quotations_terms_immutable BEFORE UPDATE ON "quotations"
  FOR EACH ROW EXECUTE FUNCTION crm_quotation_terms_immutable();

ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT;

GRANT SELECT, INSERT ON "lead_stage_history" TO crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "lead_stage_history" FROM crm_app;
GRANT SELECT, INSERT, UPDATE ON "lead_qualifications", "quotations" TO crm_app;
REVOKE DELETE, TRUNCATE ON "lead_qualifications", "quotations" FROM crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "saved_views" TO crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_stage_history','lead_qualifications','quotations','saved_views']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
