-- COMUNIDADES: regras, aprovação de entrada e pedidos pendentes; marca "editada" nos posts.
-- Idempotente: pode correr mais de uma vez sem erro.

ALTER TABLE "Community" ADD COLUMN IF NOT EXISTS "rules" TEXT;
ALTER TABLE "Community" ADD COLUMN IF NOT EXISTS "joinApproval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CommunityPost" ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP(3);

DO $$ BEGIN
  CREATE TYPE "CommunityJoinStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CommunityJoinRequest" (
  "id"          TEXT NOT NULL,
  "communityId" TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "status"      "CommunityJoinStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt" TIMESTAMP(3),
  "respondedBy" TEXT,
  CONSTRAINT "CommunityJoinRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommunityJoinRequest_communityId_userId_key" ON "CommunityJoinRequest"("communityId", "userId");
CREATE INDEX IF NOT EXISTS "CommunityJoinRequest_communityId_status_idx" ON "CommunityJoinRequest"("communityId", "status");
CREATE INDEX IF NOT EXISTS "CommunityJoinRequest_userId_idx" ON "CommunityJoinRequest"("userId");

DO $$ BEGIN
  ALTER TABLE "CommunityJoinRequest" ADD CONSTRAINT "CommunityJoinRequest_communityId_fkey"
    FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CommunityJoinRequest" ADD CONSTRAINT "CommunityJoinRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "CommunityJoinRequest" ENABLE ROW LEVEL SECURITY;
