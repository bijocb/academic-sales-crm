-- CreateEnum
CREATE TYPE "RecoveryOwnerMode" AS ENUM ('DIFFERENT_EXECUTIVE', 'SAME_OWNER', 'QUEUE');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'RECOVERED', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "loss_reasons" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "recoverable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loss_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cooldown_days" INTEGER NOT NULL DEFAULT 7,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "attempt_interval_days" INTEGER NOT NULL DEFAULT 3,
    "owner_mode" "RecoveryOwnerMode" NOT NULL DEFAULT 'DIFFERENT_EXECUTIVE',
    "auto_close_after_max" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recovery_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_status_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "reason_code" TEXT,
    "notes" TEXT,
    "actor_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_cases" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'SCHEDULED',
    "loss_reason_id" UUID NOT NULL,
    "loss_notes" TEXT NOT NULL,
    "lost_by_id" UUID,
    "lost_at" TIMESTAMPTZ(3) NOT NULL,
    "previous_owner_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "owner_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recovery_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_attempts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "notes" TEXT,
    "offered_course_id" UUID,
    "next_attempt_at" TIMESTAMPTZ(3),
    "actor_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recovery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loss_reasons_brand_id_code_key" ON "loss_reasons"("brand_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_policies_brand_id_key" ON "recovery_policies"("brand_id");

-- CreateIndex
CREATE INDEX "lead_status_history_organization_id_lead_id_occurred_at_idx" ON "lead_status_history"("organization_id", "lead_id", "occurred_at");

-- CreateIndex
CREATE INDEX "lead_status_history_organization_id_brand_id_to_status_occu_idx" ON "lead_status_history"("organization_id", "brand_id", "to_status", "occurred_at");

-- CreateIndex
CREATE INDEX "recovery_cases_organization_id_brand_id_status_next_attempt_idx" ON "recovery_cases"("organization_id", "brand_id", "status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "recovery_cases_organization_id_lead_id_idx" ON "recovery_cases"("organization_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_attempts_case_id_attempt_no_key" ON "recovery_attempts"("case_id", "attempt_no");


-- =====================================================================
-- Hand-written: integrity, append-only history, grants, RLS.
-- =====================================================================
ALTER TABLE "loss_reasons" ADD CONSTRAINT "loss_reasons_brand_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "recovery_policies" ADD CONSTRAINT "recovery_policies_brand_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "recovery_policies" ADD CONSTRAINT "recovery_policies_values_chk" CHECK ("cooldown_days" BETWEEN 0 AND 365 AND "max_attempts" BETWEEN 1 AND 20 AND "attempt_interval_days" BETWEEN 0 AND 90);

ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
CREATE TRIGGER lead_status_history_append_only BEFORE UPDATE OR DELETE ON "lead_status_history"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_attempts_chk" CHECK ("attempts" >= 0 AND "max_attempts" >= 1);
-- At most one live (scheduled or active) recovery case per lead.
CREATE UNIQUE INDEX "recovery_cases_one_live_per_lead" ON "recovery_cases"("lead_id") WHERE "status" IN ('SCHEDULED', 'ACTIVE');

ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_case_fkey" FOREIGN KEY ("case_id") REFERENCES "recovery_cases"("id") ON DELETE RESTRICT;
CREATE TRIGGER recovery_attempts_append_only BEFORE UPDATE OR DELETE ON "recovery_attempts"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

GRANT SELECT, INSERT ON "lead_status_history", "recovery_attempts" TO crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "lead_status_history", "recovery_attempts" FROM crm_app;
GRANT SELECT, INSERT, UPDATE ON "loss_reasons", "recovery_policies", "recovery_cases" TO crm_app;
REVOKE DELETE, TRUNCATE ON "loss_reasons", "recovery_policies", "recovery_cases" FROM crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['loss_reasons','recovery_policies','lead_status_history','recovery_cases','recovery_attempts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
