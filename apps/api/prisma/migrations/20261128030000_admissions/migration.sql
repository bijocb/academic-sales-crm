-- CreateEnum
CREATE TYPE "AdmissionStatus" AS ENUM ('DRAFT', 'DOCUMENTS_PENDING', 'UNDER_VERIFICATION', 'APPROVED', 'CONFIRMED', 'DEFERRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('MISSING', 'UPLOADED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "HandoverStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'DONE_MANUALLY');

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "date_of_birth" DATE,
    "gender" TEXT,
    "guardian_name" TEXT,
    "guardian_phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "country" TEXT,
    "nationality" TEXT,
    "id_type" TEXT,
    "id_number" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "number_format" TEXT NOT NULL DEFAULT '{BRAND}-{YYYY}-{SEQ:5}',
    "require_approval_to_confirm" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admission_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_types" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "required_by_default" BOOLEAN NOT NULL DEFAULT true,
    "accepted_types" TEXT[] DEFAULT ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_document_requirements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "required" BOOLEAN NOT NULL,

    CONSTRAINT "course_document_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "batch_id" UUID,
    "quotation_id" UUID,
    "status" "AdmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "admission_number" TEXT,
    "holds_seat" BOOLEAN NOT NULL DEFAULT false,
    "seat_override" BOOLEAN NOT NULL DEFAULT false,
    "seat_override_reason" TEXT,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmation_source" TEXT,
    "officer_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission_status_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "reason" TEXT,
    "actor_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admission_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "required" BOOLEAN NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'MISSING',
    "current_file_id" UUID,
    "verified_by_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admission_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_files" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "admission_document_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by_id" UUID,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_blobs" (
    "key" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "document_blobs_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "document_reviews" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "admission_document_id" UUID NOT NULL,
    "file_id" UUID,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "reviewer_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lms_handovers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "status" "HandoverStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "provider_ref" TEXT,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "completed_by_id" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lms_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "students_organization_id_person_id_key" ON "students"("organization_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "students_organization_id_id_key" ON "students"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "admission_settings_brand_id_key" ON "admission_settings"("brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_types_brand_id_code_key" ON "document_types"("brand_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "course_document_requirements_course_id_document_type_id_key" ON "course_document_requirements"("course_id", "document_type_id");

-- CreateIndex
CREATE INDEX "admissions_organization_id_brand_id_status_idx" ON "admissions"("organization_id", "brand_id", "status");

-- CreateIndex
CREATE INDEX "admissions_organization_id_batch_id_holds_seat_idx" ON "admissions"("organization_id", "batch_id", "holds_seat");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_organization_id_admission_number_key" ON "admissions"("organization_id", "admission_number");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_organization_id_id_key" ON "admissions"("organization_id", "id");

-- CreateIndex
CREATE INDEX "admission_status_history_organization_id_admission_id_occur_idx" ON "admission_status_history"("organization_id", "admission_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "admission_documents_admission_id_document_type_id_key" ON "admission_documents"("admission_id", "document_type_id");

-- CreateIndex
CREATE INDEX "document_files_organization_id_admission_document_id_upload_idx" ON "document_files"("organization_id", "admission_document_id", "uploaded_at");

-- CreateIndex
CREATE INDEX "document_reviews_organization_id_admission_document_id_occu_idx" ON "document_reviews"("organization_id", "admission_document_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "lms_handovers_admission_id_key" ON "lms_handovers"("admission_id");


-- =====================================================================
-- Hand-written: integrity, append-only history, grants, RLS.
-- =====================================================================
ALTER TABLE "students" ADD CONSTRAINT "students_person_fkey" FOREIGN KEY ("organization_id", "person_id") REFERENCES "persons"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "admission_settings" ADD CONSTRAINT "admission_settings_brand_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_brand_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "course_document_requirements" ADD CONSTRAINT "course_document_requirements_course_fkey" FOREIGN KEY ("organization_id", "course_id") REFERENCES "courses"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "course_document_requirements" ADD CONSTRAINT "course_document_requirements_type_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT;

ALTER TABLE "admissions" ADD CONSTRAINT "admissions_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_student_fkey" FOREIGN KEY ("organization_id", "student_id") REFERENCES "students"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_course_fkey" FOREIGN KEY ("organization_id", "course_id") REFERENCES "courses"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_confirmed_chk" CHECK ("status" <> 'CONFIRMED' OR ("admission_number" IS NOT NULL AND "confirmed_at" IS NOT NULL));
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_override_chk" CHECK (NOT "seat_override" OR "seat_override_reason" IS NOT NULL);
-- One live admission per lead.
CREATE UNIQUE INDEX "admissions_one_live_per_lead" ON "admissions"("lead_id") WHERE "status" NOT IN ('CANCELLED');

ALTER TABLE "admission_status_history" ADD CONSTRAINT "admission_status_history_admission_fkey" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "admissions"("organization_id", "id") ON DELETE RESTRICT;
CREATE TRIGGER admission_status_history_append_only BEFORE UPDATE OR DELETE ON "admission_status_history"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "admission_documents" ADD CONSTRAINT "admission_documents_admission_fkey" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "admissions"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "admission_documents" ADD CONSTRAINT "admission_documents_type_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT;
ALTER TABLE "admission_documents" ADD CONSTRAINT "admission_documents_rejected_chk" CHECK ("status" <> 'REJECTED' OR "rejection_reason" IS NOT NULL);

ALTER TABLE "document_files" ADD CONSTRAINT "document_files_document_fkey" FOREIGN KEY ("admission_document_id") REFERENCES "admission_documents"("id") ON DELETE RESTRICT;
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_size_chk" CHECK ("size_bytes" > 0 AND "size_bytes" <= 4194304);
CREATE TRIGGER document_files_append_only BEFORE UPDATE OR DELETE ON "document_files"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER document_blobs_append_only BEFORE UPDATE OR DELETE ON "document_blobs"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_document_fkey" FOREIGN KEY ("admission_document_id") REFERENCES "admission_documents"("id") ON DELETE RESTRICT;
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_decision_chk" CHECK ("decision" IN ('VERIFIED', 'REJECTED') AND ("decision" = 'VERIFIED' OR "reason" IS NOT NULL));
CREATE TRIGGER document_reviews_append_only BEFORE UPDATE OR DELETE ON "document_reviews"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "lms_handovers" ADD CONSTRAINT "lms_handovers_admission_fkey" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "admissions"("organization_id", "id") ON DELETE RESTRICT;

GRANT SELECT, INSERT ON "admission_status_history", "document_files", "document_blobs", "document_reviews" TO crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "admission_status_history", "document_files", "document_blobs", "document_reviews" FROM crm_app;
GRANT SELECT, INSERT, UPDATE ON "students", "admission_settings", "document_types", "admissions", "admission_documents", "lms_handovers" TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "course_document_requirements" TO crm_app;
REVOKE DELETE, TRUNCATE ON "students", "admission_settings", "document_types", "admissions", "admission_documents", "lms_handovers" FROM crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['students','admission_settings','document_types','course_document_requirements','admissions','admission_status_history','admission_documents','document_files','document_blobs','document_reviews','lms_handovers']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
