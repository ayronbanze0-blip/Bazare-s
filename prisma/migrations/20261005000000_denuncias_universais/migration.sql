-- Denúncias universais: posts, reels, histórias, comentários, posts de grupo, grupos.
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'REEL';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'STORY';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'COMMENT';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'GROUP_POST';
ALTER TYPE "ReportType" ADD VALUE IF NOT EXISTS 'COMMUNITY';

ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "targetId" TEXT;
-- Preenche o alvo genérico das denúncias antigas
UPDATE "Report" SET "targetId" = COALESCE("targetProductId", "targetUserId") WHERE "targetId" IS NULL;
CREATE INDEX IF NOT EXISTS "Report_type_targetId_idx" ON "Report"("type", "targetId");
