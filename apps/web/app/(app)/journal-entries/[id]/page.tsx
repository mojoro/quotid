import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUserId } from "@/lib/auth";
import { EntryEditor } from "@/components/journal/entry-editor.client";
import { RecordingPlayer } from "@/components/journal/recording-player.client";
import { Transcript } from "@/components/journal/transcript.client";
import { segmentsToTurns } from "@/lib/transcript";
import { fmtDuration, fmtLong, fmtTimeOfDay } from "@/lib/format";

export default async function EntryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await currentUserId();
  const { id } = await params;

  const [entry, user] = await Promise.all([
    prisma.journalEntry.findFirst({
      where: { id, userId },
      include: {
        callSession: {
          select: {
            recordingUrl: true,
            durationSeconds: true,
            startedAt: true,
            transcripts: {
              where: { kind: "REALTIME" },
              select: { segments: true },
            },
          },
        },
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    }),
  ]);

  if (!entry || !user) notFound();

  const segments = entry.callSession?.transcripts[0]?.segments;
  const turns = segmentsToTurns(segments as never);
  const duration = entry.callSession?.durationSeconds ?? null;
  const startedAt = entry.callSession?.startedAt ?? null;
  const userLabel = user.email.split("@")[0].split(/[._-]/)[0];
  const userLabelDisplay =
    userLabel.charAt(0).toUpperCase() + userLabel.slice(1);

  const eyebrowParts = [
    fmtLong(entry.entryDate),
    duration ? `${fmtDuration(duration)} call` : null,
    startedAt ? fmtTimeOfDay(startedAt) : null,
  ].filter(Boolean);

  return (
    <div
      className="mx-auto min-w-0 max-w-[660px] max-md:px-0.5"
      style={{ animation: "var(--animate-route-in)" }}
    >
      <EntryEditor
        id={entry.id}
        initialBody={entry.body}
        initialTitle={entry.title}
        eyebrow={eyebrowParts.join(" · ")}
      />

      {entry.callSession?.recordingUrl && (
        <RecordingPlayer
          src={`/api/journal-entries/${entry.id}/recording`}
          initialDuration={duration}
        />
      )}

      <Transcript turns={turns} userLabel={userLabelDisplay} />

      <div className="h-20" />
    </div>
  );
}
