-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('CALL', 'WHATSAPP', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "ActivityDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AppointmentMode" AS ENUM ('IN_PERSON', 'PHONE', 'VIDEO');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED');

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "type" "ActivityType" NOT NULL,
    "direction" "ActivityDirection" NOT NULL,
    "actor_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "duration_sec" INTEGER,
    "outcome" TEXT,
    "subject" TEXT,
    "body" TEXT,
    "template_id" UUID,
    "provider" TEXT,
    "provider_ref" TEXT,
    "task_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "channel" "ActivityType" NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sender_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "read_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT,
    "detail" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "channel" "ActivityType" NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "provider_template_name" TEXT,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "counsellor_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "mode" "AppointmentMode" NOT NULL,
    "location" TEXT,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "summary" TEXT,
    "cancel_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activities_organization_id_lead_id_occurred_at_idx" ON "activities"("organization_id", "lead_id", "occurred_at");

-- CreateIndex
CREATE INDEX "activities_organization_id_actor_user_id_occurred_at_idx" ON "activities"("organization_id", "actor_user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_activity_id_key" ON "outbound_messages"("activity_id");

-- CreateIndex
CREATE INDEX "outbound_messages_organization_id_lead_id_created_at_idx" ON "outbound_messages"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_provider_provider_ref_key" ON "outbound_messages"("provider", "provider_ref");

-- CreateIndex
CREATE INDEX "message_events_organization_id_message_id_occurred_at_idx" ON "message_events"("organization_id", "message_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_brand_id_channel_name_language_key" ON "message_templates"("brand_id", "channel", "name", "language");

-- CreateIndex
CREATE INDEX "appointments_organization_id_counsellor_id_starts_at_idx" ON "appointments"("organization_id", "counsellor_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_organization_id_lead_id_starts_at_idx" ON "appointments"("organization_id", "lead_id", "starts_at");


-- =====================================================================
-- Hand-written: integrity, append-only history, grants, RLS.
-- =====================================================================
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "activities" ADD CONSTRAINT "activities_duration_chk" CHECK ("duration_sec" IS NULL OR "duration_sec" >= 0);
ALTER TABLE "activities" ADD CONSTRAINT "activities_times_chk" CHECK ("ended_at" IS NULL OR "started_at" IS NULL OR "ended_at" >= "started_at");
CREATE TRIGGER activities_append_only BEFORE UPDATE OR DELETE ON "activities"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_activity_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE RESTRICT;
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_attempts_chk" CHECK ("attempts" >= 0);

ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_fkey" FOREIGN KEY ("message_id") REFERENCES "outbound_messages"("id") ON DELETE RESTRICT;
CREATE TRIGGER message_events_append_only BEFORE UPDATE OR DELETE ON "message_events"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_counsellor_fkey" FOREIGN KEY ("organization_id", "counsellor_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_times_chk" CHECK ("ends_at" > "starts_at");

GRANT SELECT, INSERT ON "activities", "message_events" TO crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "activities", "message_events" FROM crm_app;
GRANT SELECT, INSERT, UPDATE ON "outbound_messages", "message_templates", "appointments" TO crm_app;
REVOKE DELETE, TRUNCATE ON "outbound_messages", "message_templates", "appointments" FROM crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activities','outbound_messages','message_events','message_templates','appointments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
