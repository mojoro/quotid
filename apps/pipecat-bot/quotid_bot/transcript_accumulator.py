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

    def __init__(
        self,
        context: LLMContext,
        *,
        opening_line: str | None = None,
    ) -> None:
        super().__init__()
        self._segments: list[Segment] = []
        self._context = context
        self._opening_line = opening_line

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

        all_segments = [s.__dict__ for s in self._interleaved_segments()]
        transcript_text = " ".join(
            seg["text"] for seg in all_segments if seg.get("text")
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

    def _interleaved_segments(self) -> list[Segment]:
        """Reconstruct chronological order. The bot always speaks first
        (opening line is queued before STT can produce anything), but in the
        LLM context a user TranscriptionFrame can land BEFORE the assistant's
        opening line if STT finalizes faster than TTS — so the context order
        isn't reliable on its own. We hardcode the opening line at the front
        and skip the matching first assistant message in the context to avoid
        a duplicate.
        """
        out: list[Segment] = []
        skip_first_asst = False
        if self._opening_line:
            out.append(
                Segment(speaker="assistant", text=self._opening_line, start_ms=0)
            )
            skip_first_asst = True

        user_idx = 0
        last_t: int | None = 0
        for m in self._context.messages:
            role = m.get("role")
            if role not in ("user", "assistant"):
                continue
            content = m.get("content", "")
            if isinstance(content, list):
                content = " ".join(
                    c.get("text", "") for c in content if isinstance(c, dict)
                )
            if not isinstance(content, str) or not content:
                continue
            if role == "user":
                if user_idx < len(self._segments):
                    seg = self._segments[user_idx]
                    user_idx += 1
                    if seg.start_ms is not None:
                        last_t = seg.start_ms
                    out.append(seg)
                else:
                    out.append(Segment(speaker="user", text=content, start_ms=last_t))
            else:  # assistant
                if skip_first_asst:
                    skip_first_asst = False
                    continue
                out.append(Segment(speaker="assistant", text=content, start_ms=last_t))
        # Append any user segments that arrived after the last context flush.
        while user_idx < len(self._segments):
            out.append(self._segments[user_idx])
            user_idx += 1
        return out
