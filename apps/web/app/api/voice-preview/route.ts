import { NextRequest } from "next/server";

const PREVIEW_TEXT =
  "Hey — how was your day? Tell me what stood out, and I'll keep us moving.";

const ALLOWED_VOICES = new Set([
  "aura-2-thalia-en",
  "aura-2-orion-en",
  "aura-2-luna-en",
]);

export async function GET(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return new Response(null, { status: 401 });

  const voice = req.nextUrl.searchParams.get("voice") ?? "";
  if (!ALLOWED_VOICES.has(voice)) {
    return new Response("unknown voice", { status: 400 });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return new Response(null, { status: 503 });

  const upstream = await fetch(
    `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}&encoding=mp3`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: PREVIEW_TEXT }),
    },
  );

  if (!upstream.ok || !upstream.body) {
    return new Response(null, { status: upstream.status || 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
