-- CreateEnum
CREATE TYPE "call_status" AS ENUM ('PENDING', 'DIALING', 'IN_PROGRESS', 'COMPLETED', 'NO_ANSWER', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "transcript_kind" AS ENUM ('REALTIME', 'CANONICAL');

-- CreateEnum
CREATE TYPE "transcript_provider" AS ENUM ('DEEPGRAM', 'WHISPERX', 'OTHER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "passcode_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_schedules" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "local_time_of_day" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "temporal_schedule_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" "call_status" NOT NULL DEFAULT 'PENDING',
    "twilio_call_sid" TEXT,
    "temporal_workflow_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "recording_url" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL,
    "call_session_id" TEXT NOT NULL,
    "kind" "transcript_kind" NOT NULL,
    "provider" "transcript_provider" NOT NULL,
    "text" TEXT NOT NULL,
    "segments" JSONB NOT NULL,
    "word_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "call_session_id" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "generated_body" TEXT NOT NULL,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "entry_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_number_key" ON "users"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "call_schedules_user_id_key" ON "call_schedules"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "call_schedules_temporal_schedule_id_key" ON "call_schedules"("temporal_schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "call_sessions_twilio_call_sid_key" ON "call_sessions"("twilio_call_sid");

-- CreateIndex
CREATE UNIQUE INDEX "call_sessions_temporal_workflow_id_key" ON "call_sessions"("temporal_workflow_id");

-- CreateIndex
CREATE INDEX "call_sessions_user_id_scheduled_for_idx" ON "call_sessions"("user_id", "scheduled_for" DESC);

-- CreateIndex
CREATE INDEX "call_sessions_status_idx" ON "call_sessions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_call_session_id_kind_key" ON "transcripts"("call_session_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_call_session_id_key" ON "journal_entries"("call_session_id");

-- CreateIndex
CREATE INDEX "journal_entries_user_id_entry_date_idx" ON "journal_entries"("user_id", "entry_date" DESC);

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_schedules" ADD CONSTRAINT "call_schedules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_call_session_id_fkey" FOREIGN KEY ("call_session_id") REFERENCES "call_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_call_session_id_fkey" FOREIGN KEY ("call_session_id") REFERENCES "call_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
