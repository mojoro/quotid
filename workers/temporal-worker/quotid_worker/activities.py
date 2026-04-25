import json
import os
from datetime import datetime, time, timezone

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from .config import CONFIG
from .db import prisma
from .dto import (
    CallOutcome,
    CallOutcomeStatus,
    CreateCallSessionInput,
    CreateCallSessionResult,
    InitiateCallInput,
    InitiateCallResult,
    StoreEntryInput,
    SummarizeInput,
    SummarizeResult,
)


@activity.defn
async def create_call_session(inp: CreateCallSessionInput) -> CreateCallSessionResult:
    """Read the user, create a CallSession row, and return phone+timezone."""

    user = await prisma.user.find_unique(where={"id": inp.user_id})
    if user is None:
        raise ValueError(f"User {inp.user_id} not found")

    cs = await prisma.callsession.create(
        data={
            "userId": user.id,
            "scheduledFor": inp.scheduled_for,
            "status": "PENDING",
            "temporalWorkflowId": inp.workflow_id,
        }
    )

    return CreateCallSessionResult(
        call_session_id=cs.id,
        phone_number=user.phoneNumber,
        user_timezone=user.timezone,
    )


@activity.defn
async def initiate_call(inp: InitiateCallInput) -> InitiateCallResult:
    """Asks the Pipecat bot to place the call via its INTERNAL URL."""
    payload = {
        "workflow_id": inp.workflow_id,
        "activity_id": inp.activity_id,
        "call_session_id": inp.call_session_id,
        "phone_number": inp.to_phone,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{CONFIG.bot_internal_url}/calls", json=payload)
        if r.status_code in (400, 401, 403, 404):
            raise ApplicationError(
                f"bot rejected /calls: {r.status_code} {r.text}",
                type="TwilioClientError",
                non_retryable=True,
            )
        r.raise_for_status()
        sid = r.json()["twilio_call_sid"]

    await prisma.callsession.update(
        where={"id": inp.call_session_id},
        data={"twilioCallSid": sid, "status": "DIALING"},
    )
    return InitiateCallResult(twilio_call_sid=sid)


@activity.defn
async def await_call(call_session_id: str) -> CallOutcome:
    """ASYNC-COMPLETED activity. Must use `raise` — calling without raise silently
    completes with None (see temporal-workflow.md §3.1)."""
    raise activity.raise_complete_async()


@activity.defn
async def handle_missed_call(inp: StoreEntryInput) -> None:
    """Records failure on CallSession; no JournalEntry created for missed calls."""
    status_map = {
        CallOutcomeStatus.NO_ANSWER: "NO_ANSWER",
        CallOutcomeStatus.FAILED: "FAILED",
    }
    await prisma.callsession.update(
        where={"id": inp.outcome.call_session_id},
        data={
            "status": status_map.get(inp.outcome.status, "FAILED"),
            "endedAt": inp.outcome.ended_at,
            "failureReason": inp.outcome.failure_reason,
        },
    )


@activity.defn
async def summarize(inp: SummarizeInput) -> SummarizeResult:
    """Post-call LLM summary using OpenRouter + Sonnet 4.6."""
    api_key = os.environ["OPENROUTER_API_KEY"]
    prompt = (
        f"You are summarizing a brief journaling phone call from "
        f"{inp.entry_date} (timezone: {inp.user_timezone}) into a "
        f"Storyworthy-style entry. Output JSON with two fields: title "
        f"(short, evocative, ≤8 words) and body (2–4 sentences, "
        f"first-person, in the user's voice). No markdown, no preamble.\n\n"
        f"Transcript:\n{inp.transcript_text}"
    )

    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": "anthropic/claude-sonnet-4-6",
                "messages": [{"role": "user", "content": prompt}],
                "response_format": {"type": "json_object"},
            },
        )
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        raise ApplicationError(f"summary not JSON: {e}", non_retryable=False) from e

    return SummarizeResult(
        title=parsed.get("title", "Untitled"),
        body=parsed.get("body", ""),
    )


@activity.defn
async def store_entry(inp: StoreEntryInput) -> str:
    """Persist transcript + journal entry; finalize CallSession."""
    cs_data: dict = {
        "status": "COMPLETED",
        "twilioCallSid": inp.outcome.twilio_call_sid,
        "startedAt": inp.outcome.started_at,
        "endedAt": inp.outcome.ended_at,
        "durationSeconds": inp.outcome.duration_seconds,
    }
    if inp.outcome.recording_url is not None:
        cs_data["recordingUrl"] = inp.outcome.recording_url

    await prisma.callsession.update(where={"id": inp.outcome.call_session_id}, data=cs_data)

    if inp.outcome.transcript_text:
        from prisma import Json

        segments_json = Json(inp.outcome.transcript_segments or [])
        await prisma.transcript.upsert(
            where={
                "callSessionId_kind": {
                    "callSessionId": inp.outcome.call_session_id,
                    "kind": "REALTIME",
                }
            },
            data={
                "create": {
                    "callSession": {"connect": {"id": inp.outcome.call_session_id}},
                    "kind": "REALTIME",
                    "provider": "DEEPGRAM",
                    "text": inp.outcome.transcript_text,
                    "segments": segments_json,
                    "wordCount": len(inp.outcome.transcript_text.split()),
                },
                "update": {
                    "text": inp.outcome.transcript_text,
                    "segments": segments_json,
                    "wordCount": len(inp.outcome.transcript_text.split()),
                },
            },
        )

    if inp.summary is None:
        return ""

    entry = await prisma.journalentry.create(
        data={
            "userId": inp.user_id,
            "callSessionId": inp.outcome.call_session_id,
            "title": inp.summary.title,
            "body": inp.summary.body,
            "generatedBody": inp.summary.body,
            "isEdited": False,
            "entryDate": datetime.combine(datetime.now(timezone.utc).date(), time.min, tzinfo=timezone.utc),
        }
    )
    return entry.id
