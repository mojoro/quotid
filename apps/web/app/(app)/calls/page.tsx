import { prisma } from "@/lib/db";
import { currentUserId } from "@/lib/auth";
import { CallsListClient } from "./calls-list.client";

export default async function CallsPage() {
  const userId = await currentUserId();

  const sessions = await prisma.callSession.findMany({
    where: { userId },
    orderBy: { scheduledFor: "desc" },
    take: 200,
    include: { journalEntry: { select: { id: true, title: true } } },
  });

  const items = sessions.map((s) => ({
    id: s.id,
    scheduledFor: s.scheduledFor.toISOString(),
    startedAt: s.startedAt?.toISOString() ?? null,
    status: s.status,
    durationSeconds: s.durationSeconds,
    failureReason: s.failureReason,
    entryId: s.journalEntry?.id ?? null,
    entryTitle: s.journalEntry?.title ?? null,
  }));

  return (
    <div style={{ animation: "var(--animate-route-in)" }}>
      <div className="text-[11px] font-medium tracking-[0.16em] text-ink-3 uppercase">
        All calls
      </div>
      <h1 className="mt-2 font-display text-[clamp(32px,4.4vw,56px)] leading-[1.05] font-normal tracking-[-0.025em]">
        Conversation log
      </h1>
      <p className="mt-3 max-w-[540px] text-ink-3">
        Every check-in attempt, completed or missed. Listen back, re-read what
        we said, or jump to the journal entry.
      </p>

      <CallsListClient items={items} />

      <div className="h-20" />
    </div>
  );
}
