"""In-process correlation registry.

Maps `call_sid → (workflow_id, activity_id, call_session_id)` so the WSS
handler knows which Temporal async-activity to complete on call end.

REQUIRES uvicorn --workers=1. Multi-worker deployment would split the
registry across processes and break correlation.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class CallCorrelation:
    workflow_id: str
    activity_id: str
    call_session_id: str
    voice: str | None = None
    user_name: str | None = None


_REGISTRY: dict[str, CallCorrelation] = {}


def register(call_sid: str, corr: CallCorrelation) -> None:
    _REGISTRY[call_sid] = corr


def lookup(call_sid: str) -> CallCorrelation | None:
    return _REGISTRY.get(call_sid)


def remove(call_sid: str) -> None:
    _REGISTRY.pop(call_sid, None)
