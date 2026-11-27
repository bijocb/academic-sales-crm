-- CreateEnum
CREATE TYPE "LeadChannel" AS ENUM ('META_ADS', 'GOOGLE_ADS', 'WEBSITE', 'WHATSAPP', 'CALL', 'REFERRAL', 'EVENT', 'IMPORT', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('OPEN', 'ON_HOLD', 'LOST', 'IN_RECOVERY', 'CLOSED_LOST', 'CONVERTED');

-- CreateEnum
CREATE TYPE "EnquiryClassification" AS ENUM ('NEW_LEAD', 'EXISTING_LEAD', 'RETURNING_LEAD');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "DuplicatePolicy" AS ENUM ('ADD_ENQUIRY', 'SKIP_EXISTING');

-- CreateTable
CREATE TABLE "persons" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone_e164" TEXT,
    "phone_raw" TEXT,
    "email" TEXT,
    "city" TEXT,
    "language" TEXT,
    "do_not_contact" BOOLEAN NOT NULL DEFAULT false,
    "do_not_contact_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "lead_number" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'NEW_ENQUIRY',
    "status" "LeadStatus" NOT NULL DEFAULT 'OPEN',
    "owner_id" UUID,
    "course_id" UUID,
    "previous_lead_id" UUID,
    "first_enquiry_at" TIMESTAMPTZ(3) NOT NULL,
    "last_enquiry_at" TIMESTAMPTZ(3) NOT NULL,
    "enquiry_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "classification" "EnquiryClassification" NOT NULL,
    "channel" "LeadChannel" NOT NULL,
    "source_id" UUID,
    "campaign_id" UUID,
    "course_id" UUID,
    "dedup_key" TEXT NOT NULL,
    "external_id" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_name" TEXT,
    "submitted_phone" TEXT,
    "submitted_email" TEXT,
    "course_text" TEXT,
    "city" TEXT,
    "message" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_term" TEXT,
    "utm_content" TEXT,
    "landing_page" TEXT,
    "referrer" TEXT,
    "ad_id" TEXT,
    "adset_id" TEXT,
    "form_id" TEXT,
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "consent_marketing" BOOLEAN,
    "consent_text" TEXT,
    "consent_at" TIMESTAMPTZ(3),
    "import_id" UUID,
    "created_by_id" UUID,
    "extra" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_sources" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "LeadChannel" NOT NULL,
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "source_id" UUID,
    "name" TEXT NOT NULL,
    "utm_campaign" TEXT,
    "external_id" TEXT,
    "start_date" DATE,
    "end_date" DATE,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_keys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "intake_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_exceptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "channel" "LeadChannel" NOT NULL,
    "source_id" UUID,
    "import_id" UUID,
    "row_number" INTEGER,
    "dedup_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "errors" JSONB NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_lead_id" UUID,
    "resolution_note" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "intake_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_imports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "source_id" UUID,
    "file_name" TEXT NOT NULL,
    "duplicate_policy" "DuplicatePolicy" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "created_leads" INTEGER NOT NULL DEFAULT 0,
    "added_enquiries" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "lead_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_counters" (
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "org_counters_pkey" PRIMARY KEY ("organization_id","name")
);

-- CreateIndex
CREATE INDEX "persons_organization_id_email_idx" ON "persons"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "persons_organization_id_id_key" ON "persons"("organization_id", "id");

-- CreateIndex
CREATE INDEX "leads_organization_id_brand_id_status_created_at_idx" ON "leads"("organization_id", "brand_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "leads_organization_id_person_id_idx" ON "leads"("organization_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_organization_id_lead_number_key" ON "leads"("organization_id", "lead_number");

-- CreateIndex
CREATE UNIQUE INDEX "leads_organization_id_id_key" ON "leads"("organization_id", "id");

-- CreateIndex
CREATE INDEX "enquiries_organization_id_lead_id_received_at_idx" ON "enquiries"("organization_id", "lead_id", "received_at");

-- CreateIndex
CREATE INDEX "enquiries_organization_id_brand_id_received_at_idx" ON "enquiries"("organization_id", "brand_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "enquiries_brand_id_dedup_key_key" ON "enquiries"("brand_id", "dedup_key");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_brand_id_name_key" ON "lead_sources"("brand_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "lead_sources_organization_id_id_key" ON "lead_sources"("organization_id", "id");

-- CreateIndex
CREATE INDEX "campaigns_brand_id_utm_campaign_idx" ON "campaigns"("brand_id", "utm_campaign");

-- CreateIndex
CREATE INDEX "campaigns_brand_id_external_id_idx" ON "campaigns"("brand_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_brand_id_name_key" ON "campaigns"("brand_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_organization_id_id_key" ON "campaigns"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "intake_keys_key_hash_key" ON "intake_keys"("key_hash");

-- CreateIndex
CREATE INDEX "intake_exceptions_organization_id_brand_id_status_idx" ON "intake_exceptions"("organization_id", "brand_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "intake_exceptions_brand_id_dedup_key_key" ON "intake_exceptions"("brand_id", "dedup_key");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "persons" ADD CONSTRAINT "persons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "persons"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_course_id_fkey" FOREIGN KEY ("organization_id", "course_id") REFERENCES "courses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_organization_id_lead_id_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_organization_id_person_id_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "persons"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_organization_id_source_id_fkey" FOREIGN KEY ("organization_id", "source_id") REFERENCES "lead_sources"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_organization_id_campaign_id_fkey" FOREIGN KEY ("organization_id", "campaign_id") REFERENCES "campaigns"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_organization_id_course_id_fkey" FOREIGN KEY ("organization_id", "course_id") REFERENCES "courses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_source_id_fkey" FOREIGN KEY ("organization_id", "source_id") REFERENCES "lead_sources"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_keys" ADD CONSTRAINT "intake_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_keys" ADD CONSTRAINT "intake_keys_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_keys" ADD CONSTRAINT "intake_keys_organization_id_source_id_fkey" FOREIGN KEY ("organization_id", "source_id") REFERENCES "lead_sources"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_exceptions" ADD CONSTRAINT "intake_exceptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_exceptions" ADD CONSTRAINT "intake_exceptions_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_imports" ADD CONSTRAINT "lead_imports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_imports" ADD CONSTRAINT "lead_imports_organization_id_brand_id_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =====================================================================
-- Hand-written: integrity, append-only enquiries, grants, RLS.
-- =====================================================================
ALTER TABLE "persons" ADD CONSTRAINT "persons_contact_chk" CHECK ("phone_e164" IS NOT NULL OR "email" IS NOT NULL);
ALTER TABLE "persons" ADD CONSTRAINT "persons_email_lower_chk" CHECK ("email" IS NULL OR "email" = lower("email"));
-- One person per normalized phone per organization (A-021).
CREATE UNIQUE INDEX "persons_org_phone_uq" ON "persons" ("organization_id", "phone_e164") WHERE "phone_e164" IS NOT NULL;
-- At most one active lead per person per brand.
CREATE UNIQUE INDEX "leads_active_person_brand_uq" ON "leads" ("brand_id", "person_id")
  WHERE "status" IN ('OPEN', 'ON_HOLD', 'IN_RECOVERY');
ALTER TABLE "leads" ADD CONSTRAINT "leads_enquiry_count_chk" CHECK ("enquiry_count" >= 1);

-- Enquiries are immutable attribution records.
CREATE TRIGGER enquiries_append_only BEFORE UPDATE OR DELETE ON "enquiries"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER enquiries_no_truncate BEFORE TRUNCATE ON "enquiries"
  FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "persons", "leads", "lead_sources", "campaigns", "intake_keys", "intake_exceptions",
  "lead_imports", "outbox_events", "org_counters" TO crm_app;
GRANT SELECT, INSERT ON "enquiries" TO crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "enquiries" FROM crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['persons','leads','enquiries','lead_sources','campaigns','intake_keys',
                           'intake_exceptions','lead_imports','outbox_events','org_counters']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
