-- AlterTable
ALTER TABLE "brands" ADD COLUMN     "address" TEXT,
ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "message_templates" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'GENERAL';


-- Hand-written
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_category_chk"
  CHECK ("category" IN ('COURSE_DETAILS', 'COLLEGE_DETAILS', 'FOLLOW_UP', 'FEE_DETAILS', 'GENERAL'));
