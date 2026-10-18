-- Reparação (18 Out 2026): a 20261012000000_amizades ficou registada como aplicada na produção
-- sem criar a tabela "Friendship". Repete o mesmo SQL, idempotente: é no-op onde já existir.

DO $$ BEGIN
  CREATE TYPE "FriendshipStatus" AS ENUM ('PENDING', 'ACCEPTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Friendship" (
  "id"          TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "addresseeId" TEXT NOT NULL,
  "status"      "FriendshipStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt" TIMESTAMP(3),
  CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Friendship_requesterId_addresseeId_key" ON "Friendship"("requesterId", "addresseeId");
CREATE INDEX IF NOT EXISTS "Friendship_addresseeId_status_idx" ON "Friendship"("addresseeId", "status");
CREATE INDEX IF NOT EXISTS "Friendship_requesterId_status_idx" ON "Friendship"("requesterId", "status");

DO $$ BEGIN
  ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_requesterId_fkey"
    FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_addresseeId_fkey"
    FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Supabase: o backend liga-se como dono (ignora RLS); isto só fecha o acesso directo pela API pública.
ALTER TABLE "Friendship" ENABLE ROW LEVEL SECURITY;
