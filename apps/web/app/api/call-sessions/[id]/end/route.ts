import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(
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
    return Response.json({ ok: false, error: "call not yet placed" }, { status: 409 });
  }
  if (!(session.status === "DIALING" || session.status === "IN_PROGRESS")) {
    return Response.json({ ok: false, error: `call is ${session.status}` }, { status: 409 });
  }

  const botUrl = process.env.BOT_INTERNAL_URL;
  if (!botUrl) return new Response(null, { status: 503 });

  const upstream = await fetch(
    `${botUrl}/calls/${encodeURIComponent(session.twilioCallSid)}/end`,
    { method: "POST", cache: "no-store" },
  );
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return Response.json(
      { ok: false, error: text || `bot returned ${upstream.status}` },
      { status: 502 },
    );
  }

  return Response.json({ ok: true });
}
