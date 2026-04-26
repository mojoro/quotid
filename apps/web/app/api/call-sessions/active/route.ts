import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ status: 401 }, { status: 401 });

  const session = await prisma.callSession.findFirst({
    where: { userId, status: { in: ["DIALING", "IN_PROGRESS"] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      scheduledFor: true,
      startedAt: true,
      temporalWorkflowId: true,
    },
  });

  if (!session) return NextResponse.json({ active: null });

  return NextResponse.json({
    active: {
      id: session.id,
      status: session.status,
      scheduled_for: session.scheduledFor.toISOString(),
      started_at: session.startedAt?.toISOString() ?? null,
      workflow_id: session.temporalWorkflowId,
    },
  });
}
