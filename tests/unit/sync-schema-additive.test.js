const { test } = require('node:test');
const assert = require('assert');
const { plan } = require('../../scripts/sync-schema-additive');

const SAMPLE = `
-- CreateEnum
CREATE TYPE "S" AS ENUM ('A');

-- AlterTable
ALTER TABLE "C" ADD COLUMN "rules" TEXT,
ADD COLUMN "type" TEXT;

-- CreateTable
CREATE TABLE "F" ("id" TEXT NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "F_k" ON "F"("id");

-- AddForeignKey
ALTER TABLE "F" ADD CONSTRAINT "F_fk" FOREIGN KEY ("id") REFERENCES "U"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropIndex
DROP INDEX "x";

-- AlterTable
ALTER TABLE "P" DROP COLUMN "y";

-- AlterTable
ALTER TABLE "O" ALTER COLUMN "n" SET NOT NULL;

-- AlterTable
ALTER TABLE "O" ALTER COLUMN "t" TYPE TEXT;

-- DropTable
DROP TABLE "Z";
`;

test('aplica só o aditivo e ignora o destrutivo', () => {
  const { todo, skipped } = plan(SAMPLE);
  assert.deepStrictEqual(todo.map((b) => b.kind), ['CreateEnum', 'CreateTable', 'AlterTable', 'CreateIndex', 'AddForeignKey']);
  assert.strictEqual(skipped.length, 5);
  assert.ok(skipped.every((b) => /DROP|SET NOT NULL|TYPE/.test(b.sql)));
});

test('FK com ON DELETE CASCADE e coluna "type" não são tratadas como destrutivas', () => {
  const { todo } = plan(SAMPLE);
  assert.ok(todo.some((b) => b.kind === 'AddForeignKey'));
  assert.ok(todo.some((b) => /"type"/.test(b.sql)));
});

test('script vazio não gera nada', () => {
  const { todo, skipped } = plan('-- This is an empty migration.\n');
  assert.strictEqual(todo.length + skipped.length, 0);
});
