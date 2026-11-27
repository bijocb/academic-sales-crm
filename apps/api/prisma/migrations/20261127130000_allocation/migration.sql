-- CreateEnum
CREATE TYPE "AllocationStrategy" AS ENUM ('LEAST_LOADED', 'ROUND_ROBIN');

-- CreateEnum
CREATE TYPE "AssignmentType" AS ENUM ('AUTO', 'MANUAL', 'REASSIGN_AUTO', 'RECOVERY');

-- CreateEnum
CREATE TYPE "AllocationOutcome" AS ENUM ('ASSIGNED', 'NO_ELIGIBLE_USER', 'OUTSIDE_WORKING_HOURS', 'ALREADY_ASSIGNED', 'DISABLED');


-- AlterTable
ALTER TABLE "users" ADD COLUMN     "availability_changed_at" TIMESTAMPTZ(3),
ADD COLUMN     "is_available" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "user_leaves" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "respect_working_hours" BOOLEAN NOT NULL DEFAULT true,
    "default_strategy" "AllocationStrategy" NOT NULL DEFAULT 'LEAST_LOADED',
    "rule_version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "allocation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "course_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "channels" "LeadChannel"[] DEFAULT ARRAY[]::"LeadChannel"[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "team_id" UUID,
    "user_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "strategy" "AllocationStrategy" NOT NULL DEFAULT 'LEAST_LOADED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "allocation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" "AllocationOutcome" NOT NULL,
    "rule_id" UUID,
    "rule_version" INTEGER NOT NULL,
    "strategy" "AllocationStrategy" NOT NULL,
    "chosen_user_id" UUID,
    "candidates" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "allocation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_assignments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "from_user_id" UUID,
    "to_user_id" UUID NOT NULL,
    "type" "AssignmentType" NOT NULL,
    "reason" TEXT,
    "attempt_no" INTEGER NOT NULL,
    "allocation_run_id" UUID,
    "rule_version" INTEGER,
    "over_capacity" BOOLEAN NOT NULL DEFAULT false,
    "assigned_by_id" UUID,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "dedup_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_leaves_organization_id_user_id_start_date_idx" ON "user_leaves"("organization_id", "user_id", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "allocation_settings_brand_id_key" ON "allocation_settings"("brand_id");

-- CreateIndex
CREATE INDEX "allocation_rules_organization_id_brand_id_position_idx" ON "allocation_rules"("organization_id", "brand_id", "position");

-- CreateIndex
CREATE INDEX "allocation_runs_organization_id_lead_id_created_at_idx" ON "allocation_runs"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "allocation_runs_organization_id_brand_id_created_at_idx" ON "allocation_runs"("organization_id", "brand_id", "created_at");

-- CreateIndex
CREATE INDEX "lead_assignments_organization_id_lead_id_assigned_at_idx" ON "lead_assignments"("organization_id", "lead_id", "assigned_at");

-- CreateIndex
CREATE INDEX "lead_assignments_organization_id_to_user_id_assigned_at_idx" ON "lead_assignments"("organization_id", "to_user_id", "assigned_at");

-- CreateIndex
CREATE INDEX "notifications_organization_id_user_id_read_at_created_at_idx" ON "notifications"("organization_id", "user_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedup_key_key" ON "notifications"("user_id", "dedup_key");


-- =====================================================================
-- Hand-written: integrity, append-only history, grants, RLS.
-- =====================================================================
ALTER TABLE "user_leaves" ADD CONSTRAINT "user_leaves_dates_chk" CHECK ("end_date" >= "start_date");
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_attempt_chk" CHECK ("attempt_no" >= 1);

CREATE TRIGGER lead_assignments_append_only BEFORE UPDATE OR DELETE ON "lead_assignments"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER allocation_runs_append_only BEFORE UPDATE OR DELETE ON "allocation_runs"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_leaves", "allocation_settings", "allocation_rules", "notifications" TO crm_app;
GRANT SELECT, INSERT ON "lead_assignments", "allocation_runs" TO crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "lead_assignments", "allocation_runs" FROM crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_leaves','allocation_settings','allocation_rules','allocation_runs','lead_assignments','notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
