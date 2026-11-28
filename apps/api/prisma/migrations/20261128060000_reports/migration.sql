-- CreateEnum
CREATE TYPE "TargetMetric" AS ENUM ('ASSIGNED', 'CONTACTED', 'COUNSELLING', 'ADMISSIONS', 'REVENUE', 'COLLECTIONS');

-- CreateEnum
CREATE TYPE "TargetScope" AS ENUM ('ORGANIZATION', 'BRAND', 'TEAM', 'USER');

-- CreateEnum
CREATE TYPE "IncentiveBasis" AS ENUM ('PER_ADMISSION', 'PERCENT_OF_COLLECTIONS');

-- CreateEnum
CREATE TYPE "IncentiveRunStatus" AS ENUM ('DRAFT', 'APPROVED');

-- CreateTable
CREATE TABLE "targets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope" "TargetScope" NOT NULL,
    "brand_id" UUID,
    "team_id" UUID,
    "user_id" UUID,
    "course_id" UUID,
    "metric" "TargetMetric" NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "value" BIGINT NOT NULL,
    "currency" "Currency",
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_spend" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ad_spend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "basis" "IncentiveBasis" NOT NULL,
    "amount_minor" BIGINT,
    "percent_bp" INTEGER,
    "currency" "Currency" NOT NULL,
    "threshold_count" INTEGER NOT NULL DEFAULT 0,
    "cap_minor" BIGINT,
    "excluded_course_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "first_contact_share_pct" INTEGER NOT NULL DEFAULT 50,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incentive_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "IncentiveRunStatus" NOT NULL DEFAULT 'DRAFT',
    "total_minor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),

    CONSTRAINT "incentive_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incentive_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "inputs" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incentive_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "targets_organization_id_period_start_period_end_idx" ON "targets"("organization_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "ad_spend_campaign_id_month_key" ON "ad_spend"("campaign_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "incentive_rules_brand_id_name_version_key" ON "incentive_rules"("brand_id", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "incentive_rules_organization_id_id_key" ON "incentive_rules"("organization_id", "id");

-- CreateIndex
CREATE INDEX "incentive_runs_organization_id_brand_id_period_start_idx" ON "incentive_runs"("organization_id", "brand_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "incentive_runs_organization_id_id_key" ON "incentive_runs"("organization_id", "id");

-- CreateIndex
CREATE INDEX "incentive_lines_organization_id_run_id_idx" ON "incentive_lines"("organization_id", "run_id");

-- CreateIndex
CREATE INDEX "incentive_lines_organization_id_user_id_idx" ON "incentive_lines"("organization_id", "user_id");


-- =====================================================================
-- Hand-written: integrity, append-only history, grants, RLS.
-- =====================================================================
ALTER TABLE "targets" ADD CONSTRAINT "targets_scope_chk" CHECK (
  ("scope" = 'ORGANIZATION' AND "brand_id" IS NULL AND "team_id" IS NULL AND "user_id" IS NULL) OR
  ("scope" = 'BRAND' AND "brand_id" IS NOT NULL AND "team_id" IS NULL AND "user_id" IS NULL) OR
  ("scope" = 'TEAM' AND "team_id" IS NOT NULL AND "user_id" IS NULL) OR
  ("scope" = 'USER' AND "user_id" IS NOT NULL));
ALTER TABLE "targets" ADD CONSTRAINT "targets_period_chk" CHECK ("period_end" >= "period_start" AND "value" > 0);
ALTER TABLE "targets" ADD CONSTRAINT "targets_money_chk" CHECK (("metric" IN ('REVENUE', 'COLLECTIONS')) = ("currency" IS NOT NULL));

ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_campaign_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_amount_chk" CHECK ("amount_minor" >= 0 AND EXTRACT(DAY FROM "month") = 1);

ALTER TABLE "incentive_rules" ADD CONSTRAINT "incentive_rules_basis_chk" CHECK (
  ("basis" = 'PER_ADMISSION' AND "amount_minor" > 0) OR ("basis" = 'PERCENT_OF_COLLECTIONS' AND "percent_bp" BETWEEN 1 AND 10000));
ALTER TABLE "incentive_rules" ADD CONSTRAINT "incentive_rules_split_chk" CHECK ("first_contact_share_pct" BETWEEN 0 AND 100 AND "threshold_count" >= 0);
CREATE TRIGGER incentive_rules_append_only BEFORE UPDATE OR DELETE ON "incentive_rules"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "incentive_runs" ADD CONSTRAINT "incentive_runs_rule_fkey" FOREIGN KEY ("organization_id", "rule_id") REFERENCES "incentive_rules"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "incentive_lines" ADD CONSTRAINT "incentive_lines_run_fkey" FOREIGN KEY ("organization_id", "run_id") REFERENCES "incentive_runs"("organization_id", "id") ON DELETE RESTRICT;
CREATE TRIGGER incentive_lines_append_only BEFORE UPDATE OR DELETE ON "incentive_lines"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();
-- An approved run can never change again.
CREATE OR REPLACE FUNCTION crm_incentive_run_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN RAISE EXCEPTION 'approved incentive runs are locked'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER incentive_runs_locked BEFORE UPDATE OR DELETE ON "incentive_runs"
  FOR EACH ROW EXECUTE FUNCTION crm_incentive_run_locked();

GRANT SELECT, INSERT, UPDATE ON "targets", "ad_spend", "incentive_runs" TO crm_app;
GRANT DELETE ON "targets" TO crm_app;
GRANT SELECT, INSERT ON "incentive_rules", "incentive_lines" TO crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "incentive_rules", "incentive_lines" FROM crm_app;
REVOKE DELETE, TRUNCATE ON "ad_spend", "incentive_runs" FROM crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['targets','ad_spend','incentive_rules','incentive_runs','incentive_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
