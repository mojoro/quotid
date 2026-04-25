import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toSnake } from "@/lib/codec";

export async function GET(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ type: "about:blank", status: 401 }, { status: 401 });

  const entries = await prisma.journalEntry.findMany({
    where: { userId },
    orderBy: { entryDate: "desc" },
    take: 50,
    select: { id: true, title: true, entryDate: true, createdAt: true },
  });

  return NextResponse.json({ items: toSnake(entries as never) });
}
