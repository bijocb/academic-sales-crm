-- CreateTable
CREATE TABLE "push_devices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "app_version" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "disabled_at" TIMESTAMPTZ(3),

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices"("token");

-- CreateIndex
CREATE INDEX "push_devices_organization_id_user_id_idx" ON "push_devices"("organization_id", "user_id");


-- Hand-written: integrity, grants, RLS.
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_platform_chk" CHECK ("platform" IN ('ios', 'android', 'web'));

GRANT SELECT, INSERT, UPDATE ON "push_devices" TO crm_app;
REVOKE DELETE, TRUNCATE ON "push_devices" FROM crm_app;

ALTER TABLE "push_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "push_devices"
  USING (crm_rls_bypass() OR organization_id = crm_current_org())
  WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org());
