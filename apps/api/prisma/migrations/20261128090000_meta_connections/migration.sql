-- CreateTable
CREATE TABLE "meta_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "page_id" TEXT NOT NULL,
    "page_name" TEXT NOT NULL,
    "token_sealed" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "subscribed" BOOLEAN NOT NULL DEFAULT false,
    "last_lead_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "last_error_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "meta_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meta_connections_page_id_key" ON "meta_connections"("page_id");

-- CreateIndex
CREATE INDEX "meta_connections_organization_id_brand_id_idx" ON "meta_connections"("organization_id", "brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "meta_connections_organization_id_id_key" ON "meta_connections"("organization_id", "id");


-- =====================================================================
-- Hand-written: integrity, grants, RLS.
-- =====================================================================
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_brand_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_source_fkey" FOREIGN KEY ("organization_id", "source_id") REFERENCES "lead_sources"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_status_chk" CHECK ("status" IN ('ACTIVE', 'PAUSED') AND "page_id" ~ '^[0-9]{5,30}$');

GRANT SELECT, INSERT, UPDATE ON "meta_connections" TO crm_app;
REVOKE DELETE, TRUNCATE ON "meta_connections" FROM crm_app;

ALTER TABLE "meta_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meta_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "meta_connections"
  USING (crm_rls_bypass() OR organization_id = crm_current_org())
  WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org());
