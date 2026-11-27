-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('ONLINE', 'OFFLINE', 'HYBRID');

-- CreateEnum
CREATE TYPE "DurationUnit" AS ENUM ('DAYS', 'WEEKS', 'MONTHS', 'YEARS');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('PLANNED', 'OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SlaAction" AS ENUM ('REMIND_OWNER', 'ALERT_TEAM_LEADER', 'REASSIGN', 'ESCALATE_MANAGER');

-- CreateEnum
CREATE TYPE "TimeBasis" AS ENUM ('WORKING', 'CALENDAR');

-- CreateTable
CREATE TABLE "course_categories" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "category_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "eligibility" TEXT,
    "delivery_mode" "DeliveryMode" NOT NULL,
    "duration_value" INTEGER,
    "duration_unit" "DurationUnit",
    "list_fee_minor" BIGINT,
    "currency" "Currency" NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "branch_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "capacity" INTEGER NOT NULL,
    "schedule" TEXT,
    "status" "BatchStatus" NOT NULL DEFAULT 'PLANNED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_hours" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,

    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "first_response_minutes" INTEGER NOT NULL,
    "first_response_basis" "TimeBasis" NOT NULL DEFAULT 'WORKING',
    "max_reassign_attempts" INTEGER NOT NULL,
    "reassign_cooldown_minutes" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_checkpoints" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "action" "SlaAction" NOT NULL,
    "after_minutes" INTEGER NOT NULL,
    "basis" "TimeBasis" NOT NULL,

    CONSTRAINT "sla_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "required_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "course_categories_brand_id_code_key" ON "course_categories"("brand_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "course_categories_organization_id_id_key" ON "course_categories"("organization_id", "id");

-- CreateIndex
CREATE INDEX "courses_organization_id_brand_id_status_idx" ON "courses"("organization_id", "brand_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "courses_brand_id_code_key" ON "courses"("brand_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "courses_organization_id_id_key" ON "courses"("organization_id", "id");

-- CreateIndex
CREATE INDEX "batches_organization_id_brand_id_status_idx" ON "batches"("organization_id", "brand_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "batches_course_id_code_key" ON "batches"("course_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "batches_organization_id_id_key" ON "batches"("organization_id", "id");

-- CreateIndex
CREATE INDEX "working_hours_organization_id_brand_id_idx" ON "working_hours"("organization_id", "brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_brand_id_date_key" ON "holidays"("brand_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_brand_id_key" ON "sla_policies"("brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_organization_id_id_key" ON "sla_policies"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_organization_id_brand_id_key" ON "sla_policies"("organization_id", "brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_checkpoints_policy_id_position_key" ON "sla_checkpoints"("policy_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stages_brand_id_key_key" ON "pipeline_stages"("brand_id", "key");

-- AddForeignKey
ALTER TABLE "course_categories" ADD CONSTRAINT "course_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_categories" ADD CONSTRAINT "course_categories_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_organization_id_category_id_fkey" FOREIGN KEY ("organization_id", "category_id") REFERENCES "course_categories"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_organization_id_course_id_fkey" FOREIGN KEY ("organization_id", "course_id") REFERENCES "courses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_checkpoints" ADD CONSTRAINT "sla_checkpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_checkpoints" ADD CONSTRAINT "sla_checkpoints_organization_id_policy_id_fkey" FOREIGN KEY ("organization_id", "policy_id") REFERENCES "sla_policies"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =====================================================================
-- Hand-written: integrity checks, grants and tenant isolation (RLS).
-- =====================================================================
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_range_chk"
  CHECK ("weekday" BETWEEN 1 AND 7 AND "start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute");
ALTER TABLE "batches" ADD CONSTRAINT "batches_dates_chk" CHECK ("end_date" IS NULL OR "end_date" >= "start_date");
ALTER TABLE "batches" ADD CONSTRAINT "batches_capacity_chk" CHECK ("capacity" >= 0);
ALTER TABLE "courses" ADD CONSTRAINT "courses_fee_chk" CHECK ("list_fee_minor" IS NULL OR "list_fee_minor" >= 0);
ALTER TABLE "courses" ADD CONSTRAINT "courses_duration_chk"
  CHECK (("duration_value" IS NULL) = ("duration_unit" IS NULL) AND ("duration_value" IS NULL OR "duration_value" > 0));
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_values_chk"
  CHECK ("first_response_minutes" > 0 AND "max_reassign_attempts" >= 0 AND "reassign_cooldown_minutes" >= 0);
ALTER TABLE "sla_checkpoints" ADD CONSTRAINT "sla_checkpoints_values_chk" CHECK ("after_minutes" > 0 AND "position" >= 1);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "course_categories", "courses", "batches", "working_hours", "holidays",
  "sla_policies", "sla_checkpoints", "pipeline_stages" TO crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['course_categories','courses','batches','working_hours','holidays',
                           'sla_policies','sla_checkpoints','pipeline_stages']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
