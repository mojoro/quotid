"""In-process correlation registry.

Maps `call_sid → (workflow_id, activity_id, call_session_id)` so the WSS
handler knows which Temporal async-activity to complete on call end. A
parallel `call_sid → TranscriptCollector` map exposes the in-flight
transcript so the live-call UI can poll for what's been said so far.

REQUIRES uvicorn --workers=1. Multi-worker deployment would split the
registry across processes and break correlation.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .transcript_accumulator import TranscriptCollector


@dataclass(frozen=True)
class CallCorrelation:
    workflow_id: str
    activity_id: str
    call_session_id: str
    voice: str | None = None
    user_name: str | None = None


_REGISTRY: dict[str, CallCorrelation] = {}
_COLLECTORS: "dict[str, TranscriptCollector]" = {}


def register(call_sid: str, corr: CallCorrelation) -> None:
    _REGISTRY[call_sid] = corr


def lookup(call_sid: str) -> CallCorrelation | None:
    return _REGISTRY.get(call_sid)


def remove(call_sid: str) -> None:
    _REGISTRY.pop(call_sid, None)
    _COLLECTORS.pop(call_sid, None)


def register_collector(call_sid: str, collector: "TranscriptCollector") -> None:
    _COLLECTORS[call_sid] = collector


def lookup_collector(call_sid: str) -> "TranscriptCollector | None":
    return _COLLECTORS.get(call_sid)
