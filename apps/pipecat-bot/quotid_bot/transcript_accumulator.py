from dataclasses import dataclass
from typing import Any

from pipecat.frames.frames import Frame, TranscriptionFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass
class Segment:
    speaker: str  # "user" | "assistant"
    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    confidence: float | None = None


class TranscriptAccumulator(FrameProcessor):
    """Pass-through processor; siphons final user TranscriptionFrames."""

    def __init__(self, context: LLMContext) -> None:
        super().__init__()
        self._segments: list[Segment] = []
        self._context = context

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            is_final = getattr(frame, "is_final", True)
            if is_final and frame.text:
                self._segments.append(
                    Segment(
                        speaker="user",
                        text=frame.text,
                        start_ms=getattr(frame, "start_ms", None),
                        end_ms=getattr(frame, "end_ms", None),
                        confidence=getattr(frame, "confidence", None),
                    )
                )

        await self.push_frame(frame, direction)

    async def build_outcome(
        self,
        *,
        call_session_id: str,
        twilio_call_sid: str,
        twilio_client: Any,
    ) -> dict:
        import asyncio

        assistant_segments = self._assistant_segments_from_context()
        all_segments = [s.__dict__ for s in self._segments + assistant_segments]
        transcript_text = " ".join(
            m.get("content", "")
            for m in self._context.messages
            if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
        )

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
            call = await asyncio.to_thread(
                twilio_client.calls(twilio_call_sid).fetch
            )
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

    def _assistant_segments_from_context(self) -> list[Segment]:
        out: list[Segment] = []
        for m in self._context.messages:
            if m.get("role") != "assistant":
                continue
            content = m.get("content", "")
            if isinstance(content, list):
                content = " ".join(
                    c.get("text", "") for c in content if isinstance(c, dict)
                )
            if not content:
                continue
            out.append(Segment(speaker="assistant", text=content))
        return out
