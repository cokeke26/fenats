-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "gender" "Gender",
ADD COLUMN     "importSource" TEXT,
ADD COLUMN     "lastImportAt" TIMESTAMP(3);
