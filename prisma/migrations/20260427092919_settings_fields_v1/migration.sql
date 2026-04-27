-- AlterTable
ALTER TABLE "call_schedules" ADD COLUMN     "days_of_week" INTEGER NOT NULL DEFAULT 127;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "name" TEXT,
ADD COLUMN     "voice_preference" TEXT NOT NULL DEFAULT 'aura-2-thalia-en';
