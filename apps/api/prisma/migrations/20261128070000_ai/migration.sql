-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "priority_band" TEXT,
ADD COLUMN     "priority_score" INTEGER,
ADD COLUMN     "priority_rank" SMALLINT;

-- CreateTable
CREATE TABLE "ai_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "scoring_enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_actions_enabled" BOOLEAN NOT NULL DEFAULT true,
    "high_threshold_bp" INTEGER NOT NULL DEFAULT 2500,
    "medium_threshold_bp" INTEGER NOT NULL DEFAULT 1000,
    "min_training_size" INTEGER NOT NULL DEFAULT 50,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_models" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "positives" INTEGER NOT NULL,
    "usable" BOOLEAN NOT NULL,
    "stats" JSONB NOT NULL,
    "trained_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_scores" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "model_id" UUID,
    "model_version" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "band" TEXT NOT NULL,
    "probability_bp" INTEGER,
    "confidence" TEXT NOT NULL,
    "factors" JSONB NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_score_overrides" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "score_id" UUID,
    "band" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lead_score_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestion_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "detail" JSONB,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_suggestion_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_settings_brand_id_key" ON "ai_settings"("brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_models_brand_id_version_key" ON "ai_models"("brand_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ai_models_organization_id_id_key" ON "ai_models"("organization_id", "id");

-- CreateIndex
CREATE INDEX "lead_scores_organization_id_lead_id_computed_at_idx" ON "lead_scores"("organization_id", "lead_id", "computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_scores_organization_id_id_key" ON "lead_scores"("organization_id", "id");

-- CreateIndex
CREATE INDEX "lead_score_overrides_organization_id_lead_id_created_at_idx" ON "lead_score_overrides"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_suggestion_events_organization_id_lead_id_created_at_idx" ON "ai_suggestion_events"("organization_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "leads_organization_id_brand_id_priority_rank_priority_score_idx" ON "leads"("organization_id", "brand_id", "priority_rank", "priority_score");


-- =====================================================================
-- Hand-written: integrity, append-only history, grants, RLS.
-- =====================================================================
ALTER TABLE "leads" ADD CONSTRAINT "leads_priority_chk" CHECK (
  ("priority_band" IS NULL OR "priority_band" IN ('HIGH', 'MEDIUM', 'LOW')) AND
  ("priority_score" IS NULL OR "priority_score" BETWEEN 0 AND 100) AND
  ("priority_rank" IS NULL OR "priority_rank" BETWEEN 1 AND 3));

ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_brand_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_thresholds_chk" CHECK (
  "medium_threshold_bp" BETWEEN 1 AND 10000 AND "high_threshold_bp" BETWEEN 1 AND 10000 AND
  "high_threshold_bp" > "medium_threshold_bp" AND "min_training_size" >= 20);

ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_brand_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_counts_chk" CHECK ("version" >= 1 AND "sample_size" >= 0 AND "positives" BETWEEN 0 AND "sample_size");

ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_model_fkey" FOREIGN KEY ("organization_id", "model_id") REFERENCES "ai_models"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_values_chk" CHECK (
  "score" BETWEEN 0 AND 100 AND "band" IN ('HIGH', 'MEDIUM', 'LOW') AND "method" IN ('MODEL', 'RULES') AND
  "confidence" IN ('LOW', 'MEDIUM', 'HIGH') AND ("probability_bp" IS NULL OR "probability_bp" BETWEEN 0 AND 10000));

ALTER TABLE "lead_score_overrides" ADD CONSTRAINT "lead_score_overrides_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "lead_score_overrides" ADD CONSTRAINT "lead_score_overrides_values_chk" CHECK (
  "band" IN ('HIGH', 'MEDIUM', 'LOW') AND length(btrim("reason")) >= 5);

ALTER TABLE "ai_suggestion_events" ADD CONSTRAINT "ai_suggestion_events_lead_fkey" FOREIGN KEY ("organization_id", "lead_id") REFERENCES "leads"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "ai_suggestion_events" ADD CONSTRAINT "ai_suggestion_events_action_chk" CHECK ("action" IN ('ACCEPTED', 'DISMISSED'));

CREATE TRIGGER ai_models_append_only BEFORE UPDATE OR DELETE ON "ai_models"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER lead_scores_append_only BEFORE UPDATE OR DELETE ON "lead_scores"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER lead_score_overrides_append_only BEFORE UPDATE OR DELETE ON "lead_score_overrides"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER ai_suggestion_events_append_only BEFORE UPDATE OR DELETE ON "ai_suggestion_events"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

GRANT SELECT, INSERT, UPDATE ON "ai_settings" TO crm_app;
GRANT SELECT, INSERT ON "ai_models", "lead_scores", "lead_score_overrides", "ai_suggestion_events" TO crm_app;
REVOKE DELETE, TRUNCATE ON "ai_settings" FROM crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "ai_models", "lead_scores", "lead_score_overrides", "ai_suggestion_events" FROM crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_settings','ai_models','lead_scores','lead_score_overrides','ai_suggestion_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
