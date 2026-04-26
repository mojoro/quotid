import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ status: 401 }, { status: 401 });

  const sessions = await prisma.callSession.findMany({
    where: { userId },
    orderBy: { scheduledFor: "desc" },
    take: 200,
    include: {
      journalEntry: { select: { id: true, title: true } },
    },
  });

  return NextResponse.json({
    items: sessions.map((s) => ({
      id: s.id,
      scheduled_for: s.scheduledFor.toISOString(),
      started_at: s.startedAt?.toISOString() ?? null,
      ended_at: s.endedAt?.toISOString() ?? null,
      status: s.status,
      duration_seconds: s.durationSeconds,
      failure_reason: s.failureReason,
      entry_id: s.journalEntry?.id ?? null,
      entry_title: s.journalEntry?.title ?? null,
    })),
  });
}
