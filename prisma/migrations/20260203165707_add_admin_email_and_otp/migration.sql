/*
  Warnings:

  - A unique constraint covering the columns `[email]` on the table `AdminUser` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `email` to the `AdminUser` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "email" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "AdminOtp" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminOtp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminOtp_userId_idx" ON "AdminOtp"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- AddForeignKey
ALTER TABLE "AdminOtp" ADD CONSTRAINT "AdminOtp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
