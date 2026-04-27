import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return new Response(null, { status: 401 });

  const { id } = await params;

  const entry = await prisma.journalEntry.findFirst({
    where: { id, userId },
    select: { callSession: { select: { recordingUrl: true } } },
  });
  const path = entry?.callSession?.recordingUrl;
  if (!path) return new Response(null, { status: 404 });

  const mp3Path = path.endsWith(".json") ? path.slice(0, -5) + ".mp3" : path;
  const url = path.startsWith("http") ? path : `https://api.twilio.com${mp3Path}`;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return new Response(null, { status: 503 });

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const upstream = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(null, { status: upstream.status });
  }

  const headers: Record<string, string> = {
    "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
    "Cache-Control": "private, max-age=3600",
  };
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers["Content-Length"] = contentLength;
  const acceptRanges = upstream.headers.get("accept-ranges");
  if (acceptRanges) headers["Accept-Ranges"] = acceptRanges;

  return new Response(upstream.body, { status: 200, headers });
}
