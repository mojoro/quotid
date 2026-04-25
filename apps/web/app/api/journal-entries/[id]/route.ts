import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toSnake } from "@/lib/codec";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ status: 401 }, { status: 401 });
  const { id } = await params;

  const entry = await prisma.journalEntry.findFirst({
    where: { id, userId },
    include: {
      callSession: {
        include: { transcripts: { where: { kind: "REALTIME" } } },
      },
    },
  });

  if (!entry) return NextResponse.json({ status: 404 }, { status: 404 });

  const transcript = entry.callSession?.transcripts[0]?.text ?? null;
  return NextResponse.json(toSnake({
    id: entry.id,
    title: entry.title,
    body: entry.body,
    entryDate: entry.entryDate.toISOString(),
    transcriptText: transcript,
  } as never));
}
