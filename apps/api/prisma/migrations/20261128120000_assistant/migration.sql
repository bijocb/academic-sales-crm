-- CreateTable
CREATE TABLE "assistant_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "brief_enabled" BOOLEAN NOT NULL DEFAULT true,
    "monthly_question_limit" INTEGER NOT NULL DEFAULT 500,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assistant_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_questions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'QUESTION',
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "tools_used" JSONB NOT NULL DEFAULT '[]',
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assistant_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assistant_settings_organization_id_key" ON "assistant_settings"("organization_id");

-- CreateIndex
CREATE INDEX "assistant_questions_organization_id_created_at_idx" ON "assistant_questions"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "assistant_questions_organization_id_user_id_created_at_idx" ON "assistant_questions"("organization_id", "user_id", "created_at");



-- Hand-written: integrity, append-only history, grants, RLS (A-052).
ALTER TABLE "assistant_settings" ADD CONSTRAINT "assistant_settings_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "assistant_settings" ADD CONSTRAINT "assistant_settings_limit_chk" CHECK ("monthly_question_limit" BETWEEN 0 AND 100000);
ALTER TABLE "assistant_questions" ADD CONSTRAINT "assistant_questions_user_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "assistant_questions" ADD CONSTRAINT "assistant_questions_kind_chk" CHECK ("kind" IN ('QUESTION', 'BRIEF'));
ALTER TABLE "assistant_questions" ADD CONSTRAINT "assistant_questions_status_chk" CHECK ("status" IN ('ANSWERED', 'FAILED', 'REFUSED'));

CREATE TRIGGER assistant_questions_append_only BEFORE UPDATE OR DELETE ON "assistant_questions"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

GRANT SELECT, INSERT, UPDATE ON "assistant_settings" TO crm_app;
GRANT SELECT, INSERT ON "assistant_questions" TO crm_app;
REVOKE DELETE, TRUNCATE ON "assistant_settings" FROM crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "assistant_questions" FROM crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_settings','assistant_questions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
