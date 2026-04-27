import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return new Response(null, { status: 401 });

  const { id } = await params;

  const session = await prisma.callSession.findFirst({
    where: { id, userId },
    select: { twilioCallSid: true, status: true },
  });
  if (!session) return new Response(null, { status: 404 });
  if (!session.twilioCallSid) {
    // Call hasn't been placed yet (PENDING) — nothing to show.
    return Response.json({ segments: [] });
  }

  const botUrl = process.env.BOT_INTERNAL_URL;
  if (!botUrl) return new Response(null, { status: 503 });

  const upstream = await fetch(
    `${botUrl}/calls/${encodeURIComponent(session.twilioCallSid)}/transcript`,
    { cache: "no-store" },
  );
  if (!upstream.ok) {
    return Response.json({ segments: [] });
  }
  const body = await upstream.json();
  return Response.json(body);
}
