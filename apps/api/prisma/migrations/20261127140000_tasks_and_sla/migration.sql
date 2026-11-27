-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('FIRST_CALL', 'CALL_BACK', 'WHATSAPP', 'EMAIL', 'COUNSELLING', 'DOCUMENT_COLLECTION', 'PAYMENT_FOLLOW_UP', 'ADMISSION_CONFIRMATION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskOutcome" AS ENUM ('CONNECTED', 'NO_ANSWER', 'BUSY', 'SWITCHED_OFF', 'WRONG_NUMBER', 'CALL_BACK_REQUESTED', 'MESSAGE_SENT', 'DONE');

-- CreateEnum
CREATE TYPE "SlaState" AS ENUM ('PENDING', 'AT_RISK', 'BREACHED', 'PAUSED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'DEAD', 'CANCELLED');


-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "type" "TaskType" NOT NULL,
    "title" TEXT NOT NULL,
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "channel" TEXT,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "is_initial" BOOLEAN NOT NULL DEFAULT false,
    "outcome" "TaskOutcome",
    "notes" TEXT,
    "cancel_reason" TEXT,
    "reschedule_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_instances" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'FIRST_RESPONSE',
    "state" "SlaState" NOT NULL DEFAULT 'PENDING',
    "owner_id" UUID NOT NULL,
    "target_minutes" INTEGER NOT NULL,
    "basis" "TimeBasis" NOT NULL,
    "checkpoints" JSONB NOT NULL,
    "fired_positions" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "generation" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "segment_started_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_calendar_minutes" INTEGER NOT NULL DEFAULT 0,
    "consumed_working_minutes" INTEGER NOT NULL DEFAULT 0,
    "due_at" TIMESTAMPTZ(3),
    "paused_at" TIMESTAMPTZ(3),
    "breached_at" TIMESTAMPTZ(3),
    "escalated_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "resolution" TEXT,
    "resolved_by_id" UUID,
    "calendar_minutes" INTEGER,
    "working_minutes" INTEGER,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sla_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sla_instance_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "position" INTEGER,
    "data" JSONB,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sla_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "run_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "last_error" TEXT,
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_organization_id_owner_id_status_due_at_idx" ON "tasks"("organization_id", "owner_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "tasks_organization_id_lead_id_status_idx" ON "tasks"("organization_id", "lead_id", "status");

-- CreateIndex
CREATE INDEX "tasks_organization_id_brand_id_status_due_at_idx" ON "tasks"("organization_id", "brand_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "sla_instances_organization_id_brand_id_state_idx" ON "sla_instances"("organization_id", "brand_id", "state");

-- CreateIndex
CREATE INDEX "sla_instances_organization_id_lead_id_idx" ON "sla_instances"("organization_id", "lead_id");

-- CreateIndex
CREATE INDEX "sla_events_organization_id_sla_instance_id_occurred_at_idx" ON "sla_events"("organization_id", "sla_instance_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_key_key" ON "jobs"("key");

-- CreateIndex
CREATE INDEX "jobs_status_run_at_idx" ON "jobs"("status", "run_at");

-- CreateIndex
CREATE INDEX "jobs_organization_id_status_idx" ON "jobs"("organization_id", "status");


-- =====================================================================
-- Hand-written: integrity, append-only history, grants, RLS.
-- =====================================================================
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_fkey" FOREIGN KEY ("organization_id", "owner_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reschedule_chk" CHECK ("reschedule_count" >= 0);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_chk" CHECK ("status" <> 'COMPLETED' OR ("outcome" IS NOT NULL AND "completed_at" IS NOT NULL));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_cancelled_chk" CHECK ("status" <> 'CANCELLED' OR ("cancel_reason" IS NOT NULL AND "cancelled_at" IS NOT NULL));
-- Exactly one first task per lead, even if allocation retries.
CREATE UNIQUE INDEX "tasks_one_initial_per_lead" ON "tasks"("lead_id") WHERE "is_initial";

ALTER TABLE "sla_instances" ADD CONSTRAINT "sla_instances_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "sla_instances" ADD CONSTRAINT "sla_instances_minutes_chk" CHECK ("target_minutes" > 0 AND "consumed_calendar_minutes" >= 0 AND "consumed_working_minutes" >= 0);
-- One running clock per lead and kind.
CREATE UNIQUE INDEX "sla_instances_one_active_per_lead" ON "sla_instances"("lead_id", "kind") WHERE "state" IN ('PENDING', 'AT_RISK', 'BREACHED', 'PAUSED');

ALTER TABLE "sla_events" ADD CONSTRAINT "sla_events_instance_fkey" FOREIGN KEY ("sla_instance_id") REFERENCES "sla_instances"("id") ON DELETE RESTRICT;
CREATE TRIGGER sla_events_append_only BEFORE UPDATE OR DELETE ON "sla_events"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_attempts_chk" CHECK ("attempts" >= 0 AND "max_attempts" >= 1);

GRANT SELECT, INSERT, UPDATE ON "tasks", "sla_instances", "jobs" TO crm_app;
GRANT SELECT, INSERT ON "sla_events" TO crm_app;
REVOKE DELETE, TRUNCATE ON "tasks", "sla_instances", "jobs" FROM crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "sla_events" FROM crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','sla_instances','sla_events','jobs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
