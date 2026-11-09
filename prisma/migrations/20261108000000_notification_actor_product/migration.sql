-- Notificações com foto: guarda quem fez a acção e o produto em causa (nullable, sem FK).
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "actorId" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "productId" TEXT;
