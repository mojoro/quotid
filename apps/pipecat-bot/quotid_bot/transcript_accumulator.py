from dataclasses import dataclass
from typing import Any

from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass
class Segment:
    speaker: str  # "user" | "assistant"
    text: str


class TranscriptCollector:
    """Single source of truth for the call's chronological transcript.

    User and assistant frame processors append to the same `segments` list as
    final-form text becomes available, so the order is naturally chronological
    — no post-hoc reassembly from LLM context.
    """

    def __init__(self, *, opening_line: str | None = None) -> None:
        self.segments: list[Segment] = []
        if opening_line and opening_line.strip():
            self.segments.append(Segment("assistant", opening_line.strip()))

    async def build_outcome(
        self,
        *,
        call_session_id: str,
        twilio_call_sid: str,
        twilio_client: Any,
    ) -> dict:
        import asyncio

        all_segments = [{"speaker": s.speaker, "text": s.text} for s in self.segments]
        transcript_text = " ".join(s.text for s in self.segments if s.text)

        try:
            recordings = await asyncio.to_thread(
                twilio_client.recordings.list, call_sid=twilio_call_sid, limit=1
            )
            recording_url = recordings[0].uri if recordings else None
        except Exception:
            recording_url = None

        started_at = None
        ended_at = None
        duration_seconds = None
        try:
            call = await asyncio.to_thread(twilio_client.calls(twilio_call_sid).fetch)
            started_at = call.start_time.isoformat() if call.start_time else None
            ended_at = call.end_time.isoformat() if call.end_time else None
            duration_seconds = int(call.duration) if call.duration else None
        except Exception:
            pass

        return {
            "status": "COMPLETED",
            "call_session_id": call_session_id,
            "twilio_call_sid": twilio_call_sid,
            "transcript_text": transcript_text,
            "transcript_segments": all_segments,
            "recording_url": recording_url,
            "started_at": started_at,
            "ended_at": ended_at,
            "duration_seconds": duration_seconds,
        }


class UserTranscriptCapture(FrameProcessor):
    """Sits after STT and before the user aggregator. Records each final
    user transcription as it lands.
    """

    def __init__(self, collector: TranscriptCollector) -> None:
        super().__init__()
        self._collector = collector

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            is_final = getattr(frame, "is_final", True)
            text = (frame.text or "").strip()
            if is_final and text:
                self._collector.segments.append(Segment("user", text))
        await self.push_frame(frame, direction)


class AssistantTextCapture(FrameProcessor):
    """Sits after the LLM and before TTS. Buffers streamed LLMTextFrames
    between LLMFullResponseStartFrame and LLMFullResponseEndFrame, then
    appends the joined text as a single assistant segment.
    """

    def __init__(self, collector: TranscriptCollector) -> None:
        super().__init__()
        self._collector = collector
        self._buffer = ""
        self._in_response = False

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self._buffer = ""
            self._in_response = True
        elif isinstance(frame, LLMFullResponseEndFrame):
            text = self._buffer.strip()
            if text:
                self._collector.segments.append(Segment("assistant", text))
            self._buffer = ""
            self._in_response = False
        elif isinstance(frame, LLMTextFrame) and self._in_response:
            self._buffer += frame.text or ""
        await self.push_frame(frame, direction)
