-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'DISPUTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('GATEWAY', 'CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'CARD_MACHINE');

-- AlterEnum
ALTER TYPE "AdmissionStatus" ADD VALUE 'CANCELLED_REFUNDED';

-- CreateTable
CREATE TABLE "finance_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "receipt_number_format" TEXT NOT NULL DEFAULT '{BRAND}-RCPT-{YYYY}-{SEQ:6}',
    "min_confirm_amount_minor" BIGINT NOT NULL DEFAULT 1,
    "default_due_days" INTEGER NOT NULL DEFAULT 7,
    "refund_maker_checker" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_plans" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "base_amount_minor" BIGINT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_adjustments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instalments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "due_date" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,

    CONSTRAINT "instalments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_order_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'INITIATED',
    "checkout_url" TEXT,
    "mismatch" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_checked_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "attempt_id" UUID,
    "result" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "attempt_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "receipt_number" TEXT NOT NULL,
    "verification" TEXT NOT NULL,
    "verified_by_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by_id" UUID,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "method" TEXT,
    "reference" TEXT,
    "paid_on" DATE,
    "actor_user_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refund_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "finance_settings_brand_id_key" ON "finance_settings"("brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_plans_admission_id_key" ON "fee_plans"("admission_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_plans_organization_id_id_key" ON "fee_plans"("organization_id", "id");

-- CreateIndex
CREATE INDEX "fee_adjustments_organization_id_plan_id_idx" ON "fee_adjustments"("organization_id", "plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "instalments_plan_id_seq_key" ON "instalments"("plan_id", "seq");

-- CreateIndex
CREATE INDEX "payment_attempts_organization_id_status_created_at_idx" ON "payment_attempts"("organization_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_provider_provider_order_id_key" ON "payment_attempts"("provider", "provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_event_id_key" ON "payment_events"("provider", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_attempt_id_key" ON "payments"("attempt_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_admission_id_received_at_idx" ON "payments"("organization_id", "admission_id", "received_at");

-- CreateIndex
CREATE INDEX "payments_organization_id_brand_id_received_at_idx" ON "payments"("organization_id", "brand_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organization_id_receipt_number_key" ON "payments"("organization_id", "receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organization_id_id_key" ON "payments"("organization_id", "id");

-- CreateIndex
CREATE INDEX "refunds_organization_id_payment_id_idx" ON "refunds"("organization_id", "payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_organization_id_id_key" ON "refunds"("organization_id", "id");

-- CreateIndex
CREATE INDEX "refund_events_organization_id_refund_id_occurred_at_idx" ON "refund_events"("organization_id", "refund_id", "occurred_at");


-- =====================================================================
-- Hand-written: integrity, append-only history, grants, RLS.
-- =====================================================================

ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_brand_fkey" FOREIGN KEY ("organization_id", "brand_id") REFERENCES "brands"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_values_chk" CHECK ("min_confirm_amount_minor" >= 1 AND "default_due_days" BETWEEN 0 AND 365);

ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_admission_fkey" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "admissions"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_amount_chk" CHECK ("base_amount_minor" >= 0);

ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_plan_fkey" FOREIGN KEY ("organization_id", "plan_id") REFERENCES "fee_plans"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_amount_chk" CHECK ("amount_minor" <> 0);
CREATE TRIGGER fee_adjustments_append_only BEFORE UPDATE OR DELETE ON "fee_adjustments"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "instalments" ADD CONSTRAINT "instalments_plan_fkey" FOREIGN KEY ("organization_id", "plan_id") REFERENCES "fee_plans"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "instalments" ADD CONSTRAINT "instalments_amount_chk" CHECK ("amount_minor" > 0 AND "seq" >= 1);

ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_plan_fkey" FOREIGN KEY ("organization_id", "plan_id") REFERENCES "fee_plans"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_amount_chk" CHECK ("amount_minor" > 0);

CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON "payment_events"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_fkey" FOREIGN KEY ("organization_id", "plan_id") REFERENCES "fee_plans"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "payments" ADD CONSTRAINT "payments_admission_fkey" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "admissions"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_chk" CHECK ("amount_minor" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_verification_chk" CHECK ("verification" IN ('GATEWAY_WEBHOOK', 'GATEWAY_RECONCILIATION', 'MANUAL'));
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_fkey" FOREIGN KEY ("organization_id", "payment_id") REFERENCES "payments"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_chk" CHECK ("amount_minor" > 0);
CREATE TRIGGER refunds_append_only BEFORE UPDATE OR DELETE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_refund_fkey" FOREIGN KEY ("organization_id", "refund_id") REFERENCES "refunds"("organization_id", "id") ON DELETE RESTRICT;
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_type_chk" CHECK ("type" IN ('APPROVED', 'REJECTED', 'PAID'));
CREATE TRIGGER refund_events_append_only BEFORE UPDATE OR DELETE ON "refund_events"
  FOR EACH ROW EXECUTE FUNCTION crm_block_mutation();

GRANT SELECT, INSERT ON "fee_adjustments", "payment_events", "payments", "refunds", "refund_events" TO crm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "fee_adjustments", "payment_events", "payments", "refunds", "refund_events" FROM crm_app;
GRANT SELECT, INSERT, UPDATE ON "finance_settings", "fee_plans", "payment_attempts" TO crm_app;
REVOKE DELETE, TRUNCATE ON "finance_settings", "fee_plans", "payment_attempts" FROM crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "instalments" TO crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_settings','fee_plans','fee_adjustments','instalments','payment_attempts','payment_events','payments','refunds','refund_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (crm_rls_bypass() OR organization_id = crm_current_org()) '
      'WITH CHECK (crm_rls_bypass() OR organization_id = crm_current_org())', t);
  END LOOP;
END $$;
