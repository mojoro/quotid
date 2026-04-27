import { NextRequest, NextResponse } from "next/server";
import { getTemporalClient } from "@/lib/temporal-client";
import { prisma } from "@/lib/db";
import twilio from "twilio";

const ABNORMAL: ReadonlySet<string> = new Set(["no-answer", "failed", "busy", "canceled"]);

const STATUS_MAP: Record<string, "NO_ANSWER" | "FAILED"> = {
  "no-answer": "NO_ANSWER",
  failed: "FAILED",
  busy: "NO_ANSWER",
  canceled: "FAILED",
};

export async function POST(req: NextRequest) {
  const sig = req.headers.get("x-twilio-signature") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const reqPath = new URL(req.url).pathname + new URL(req.url).search;
  const externalUrl = `${proto}://${host}${reqPath}`;
  const formText = await req.text();
  const params = new URLSearchParams(formText);
  const paramsObj = Object.fromEntries(params.entries());

  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN!,
    sig,
    externalUrl,
    paramsObj
  );
  if (!valid) return new NextResponse("Forbidden", { status: 403 });

  const callSid = params.get("CallSid");
  const callStatus = params.get("CallStatus");
  if (!callSid || !callStatus) return new NextResponse(null, { status: 204 });

  // Twilio "answered" event arrives as CallStatus="in-progress". Mark the
  // CallSession live so the dashboard banner can flip from "Calling" → "Live".
  if (callStatus === "in-progress") {
    await prisma.callSession.updateMany({
      where: { twilioCallSid: callSid, status: { in: ["DIALING", "PENDING"] } },
      data: { status: "IN_PROGRESS", startedAt: new Date() },
    });
    return new NextResponse(null, { status: 204 });
  }

  if (!ABNORMAL.has(callStatus)) return new NextResponse(null, { status: 204 });

  const cs = await prisma.callSession.findUnique({
    where: { twilioCallSid: callSid },
    select: { temporalWorkflowId: true, id: true },
  });
  if (!cs) return new NextResponse(null, { status: 204 });

  const client = await getTemporalClient();
  try {
    await client.activity.complete(
      { workflowId: cs.temporalWorkflowId, activityId: "await-call" },
      {
        status: STATUS_MAP[callStatus] ?? "FAILED",
        call_session_id: cs.id,
        twilio_call_sid: callSid,
        failure_reason: `twilio:${callStatus}`,
      }
    );
  } catch {
    // Activity may already be complete (race with Pipecat) — swallow.
  }

  return new NextResponse(null, { status: 204 });
}
