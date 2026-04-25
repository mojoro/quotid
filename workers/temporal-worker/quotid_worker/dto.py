from datetime import datetime
from enum import Enum
from pydantic import BaseModel, Field


# ─── Workflow input ──────────────────────────────────────────────────────

class JournalingWorkflowInput(BaseModel):
    user_id: str
    call_schedule_id: str | None = None  # None for manual triggers
    scheduled_for: datetime              # UTC instant — drives entry_date


# ─── Activity inputs / outputs ───────────────────────────────────────────

class CreateCallSessionInput(BaseModel):
    user_id: str
    scheduled_for: datetime
    workflow_id: str  # pinned to CallSession.temporal_workflow_id


class CreateCallSessionResult(BaseModel):
    call_session_id: str
    phone_number: str  # E.164
    user_timezone: str


class InitiateCallInput(BaseModel):
    call_session_id: str
    workflow_id: str
    activity_id: str  # deterministic: "await-call"
    to_phone: str


class InitiateCallResult(BaseModel):
    twilio_call_sid: str


class CallOutcomeStatus(str, Enum):
    COMPLETED = "COMPLETED"
    NO_ANSWER = "NO_ANSWER"
    FAILED = "FAILED"


class CallOutcome(BaseModel):
    status: CallOutcomeStatus
    call_session_id: str
    twilio_call_sid: str
    started_at: datetime | None = None
    ended_at: datetime | None = None
    duration_seconds: int | None = None
    recording_url: str | None = None
    transcript_text: str | None = None
    transcript_segments: list[dict] | None = Field(default=None)
    failure_reason: str | None = None


class SummarizeInput(BaseModel):
    transcript_text: str
    user_timezone: str
    entry_date: str  # ISO date "2026-04-24"


class SummarizeResult(BaseModel):
    title: str
    body: str


class StoreEntryInput(BaseModel):
    user_id: str
    call_session_id: str
    outcome: CallOutcome
    summary: SummarizeResult | None = None
