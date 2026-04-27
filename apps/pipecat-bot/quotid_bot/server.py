import asyncio
import json
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Header, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from loguru import logger
from pipecat.pipeline.runner import PipelineRunner
from pydantic import BaseModel
from twilio.rest import Client as TwilioClient

from .config import CONFIG
from .correlation import CallCorrelation, lookup, register, remove
from .pipeline import build_pipeline
from .temporal_completion import complete_await_call, fail_await_call
from .twilio_signature import verify

twilio = TwilioClient(CONFIG.twilio_account_sid, CONFIG.twilio_auth_token)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield


app = FastAPI(lifespan=lifespan)


# ─── POST /calls ───────────────────────────────────────────────────────────

class CreateCallRequest(BaseModel):
    workflow_id: str
    activity_id: str
    call_session_id: str
    to_phone: str  # E.164 — destination of the outbound call (the user's phone)
    voice: str | None = None  # Deepgram Aura voice id; None falls back to bot default
    user_name: str | None = None  # Used in greeting + system prompt


class CreateCallResponse(BaseModel):
    twilio_call_sid: str


@app.post("/calls", response_model=CreateCallResponse, status_code=202)
async def create_call(req: CreateCallRequest) -> CreateCallResponse:
    twiml_url = f"{CONFIG.bot_public_url}/calls/{req.call_session_id}/twiml"
    status_callback_url = f"{CONFIG.app_public_url}/api/webhooks/twilio/call-status"

    call = await asyncio.to_thread(
        twilio.calls.create,
        to=req.to_phone,
        from_=CONFIG.twilio_phone_number,
        url=twiml_url,
        status_callback=status_callback_url,
        status_callback_event=["initiated", "ringing", "answered", "completed"],
        record=True,
        recording_channels="dual",
    )

    register(
        call.sid,
        CallCorrelation(
            workflow_id=req.workflow_id,
            activity_id=req.activity_id,
            call_session_id=req.call_session_id,
            voice=req.voice,
            user_name=req.user_name,
        ),
    )
    logger.info(f"Created Twilio call {call.sid} for workflow {req.workflow_id}")
    return CreateCallResponse(twilio_call_sid=call.sid)


# ─── GET/POST /calls/{call_session_id}/twiml ─────────────────────────────────

@app.api_route("/calls/{call_session_id}/twiml", methods=["GET", "POST"])
async def twiml(
    call_session_id: str,
    request: Request,
    x_twilio_signature: str | None = Header(default=None),
) -> PlainTextResponse:
    form = dict((await request.form()) if request.method == "POST" else {})
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    full_url = f"{proto}://{host}{request.url.path}"
    if request.url.query:
        full_url += f"?{request.url.query}"
    if not verify(full_url, form, x_twilio_signature):
        logger.warning(f"Invalid Twilio signature on /twiml for {call_session_id} (url={full_url})")
        raise HTTPException(status_code=403)

    stream_url = (
        f"{CONFIG.bot_public_url.replace('https://', 'wss://').replace('http://', 'ws://')}"
        f"/calls/{call_session_id}/stream"
    )
    twiml_body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Response>'
        f'<Connect><Stream url="{stream_url}"/></Connect>'
        '</Response>'
    )
    return PlainTextResponse(content=twiml_body, media_type="application/xml")


# ─── WSS /calls/{call_session_id}/stream ────────────────────────────────────

@app.websocket("/calls/{call_session_id}/stream")
async def stream(websocket: WebSocket, call_session_id: str) -> None:
    await websocket.accept()
    logger.info(f"WSS opened for call_session_id={call_session_id}")

    async def safe_close(code: int) -> None:
        try:
            await websocket.close(code=code)
        except Exception:
            pass

    start_msg = None
    try:
        async for raw in websocket.iter_text():
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning(f"WSS got non-JSON frame: {raw[:120]}")
                continue
            event = msg.get("event")
            logger.info(f"WSS event: {event}")
            if event == "start":
                start_msg = msg
                break
    except WebSocketDisconnect:
        logger.info(f"WSS disconnected before start for call_session_id={call_session_id}")
        return

    if start_msg is None:
        logger.warning(f"WSS closed before start event for call_session_id={call_session_id}")
        await safe_close(1011)
        return

    stream_sid = start_msg["start"]["streamSid"]
    call_sid = start_msg["start"]["callSid"]
    logger.info(f"WSS start: stream_sid={stream_sid} call_sid={call_sid}")

    corr = lookup(call_sid)
    if corr is None:
        logger.error(f"No correlation for callSid {call_sid}; closing")
        await safe_close(1011)
        return

    task, collector, _context = build_pipeline(
        websocket,
        stream_sid,
        call_sid,
        voice=corr.voice,
        user_name=corr.user_name,
    )

    runner = PipelineRunner(handle_sigint=False)

    try:
        await runner.run(task)
    except (WebSocketDisconnect, asyncio.CancelledError):
        logger.info(f"WSS disconnected/cancelled for callSid {call_sid}")
    except Exception:
        logger.exception(f"Pipeline error for callSid {call_sid}")
        await fail_await_call(corr.workflow_id, "pipeline_error")
        remove(call_sid)
        return

    logger.info(f"Building outcome for callSid {call_sid}")
    payload = await collector.build_outcome(
        call_session_id=corr.call_session_id,
        twilio_call_sid=call_sid,
        twilio_client=twilio,
    )
    logger.info(f"Completing await_call for workflow {corr.workflow_id}")
    await complete_await_call(corr.workflow_id, payload)
    remove(call_sid)
    logger.info(f"Call session {corr.call_session_id} finalized")


def run() -> None:
    import uvicorn
    uvicorn.run("quotid_bot.server:app", host="0.0.0.0", port=8000, workers=1, log_level="info")
