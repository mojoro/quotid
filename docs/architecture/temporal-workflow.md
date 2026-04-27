# Temporal Workflow Design — Quotid

**Scope:** Step 3 of the design phase. Defines the `JournalingWorkflow`, its activities, schedule pattern, watchdog pattern, error taxonomy, and timeout/retry policies.

**Deliverable:** design doc + Python pseudocode signatures. **No implementation.**

**Authoritative sources consumed:**
- `docs/architecture/likec4/quotid.c4` — especially `callFlow` and `callSequence` views
- `prisma/schema.prisma` — `User`, `CallSchedule`, `CallSession`, `Transcript`, `JournalEntry`
- `docs/SESSION_HANDOFF.md` — locked design decisions (cited by number where relevant)

---

## 1. Overview

One workflow instance per **call attempt**, not per user. A Temporal **Schedule** (one per `CallSchedule` row) fires at the user's local `21:00` and starts a new `JournalingWorkflow` run. The workflow drives: DB bookkeeping → outbound call → in-call wait → post-call summarization → journal write.

Why per-attempt and not long-lived per-user: long-lived workflows accumulate history, complicate replays, and offer no advantage here — there is no cross-call state to carry. Each nightly attempt is independent.

## 2. Workflow state machine

```
   SCHEDULE FIRES  (or manual trigger via triggerTestCall)
        │
        ▼
   ┌─────────────────────┐
   │ create_call_session │  inserts CallSession row (PENDING)
   └─────────────────────┘
        │
        ▼
   ┌─────────────────────┐
   │ initiate_call       │  POST /calls → Pipecat; returns {call_sid}
   └─────────────────────┘
        │
        ▼
   ┌─────────────────────┐
   │ await_call          │  async-completed by Pipecat OR watchdog
   └─────────────────────┘   returns CallOutcome (COMPLETED | NO_ANSWER | FAILED)
        │
        ├── NO_ANSWER / FAILED ──► handle_missed_call → END
        │
        └── COMPLETED ──┐
                        ▼
                 ┌─────────────────┐
                 │ summarize       │  Sonnet, via OpenRouter
                 └─────────────────┘
                        │
                        ▼
                 ┌─────────────────┐
                 │ store_entry     │  INSERT journal_entry + update CallSession
                 └─────────────────┘
                        │
                      END
```

All transitions are via `workflow.execute_activity(...)`. The workflow body is a single linear `async def run(...)` with two branches after `await_call`. No child workflows, no signals-driving-state-machine pattern — keep it flat.

## 3. Activity catalogue

| Activity | Run type | `start_to_close` | Retry | Invoked from |
|---|---|---|---|---|
| `create_call_session` | regular | 10 s | default (max 3) | `JournalingWorkflow` |
| `initiate_call` | regular | 30 s | **custom**: 3 attempts, non-retryable for 4xx; retry 5xx/network | `JournalingWorkflow` |
| `await_call` | **async completion** | **20 min** (backstop) | **no retry** (1 attempt) | `JournalingWorkflow`; completed externally by Pipecat or watchdog |
| `handle_missed_call` | regular | 10 s | default (max 3) | `JournalingWorkflow` (NO_ANSWER/FAILED branch) |
| `summarize` | regular | 2 min | **custom**: 3 attempts, backoff 5s→60s | `JournalingWorkflow` (COMPLETED branch) |
| `store_entry` | regular | 15 s | default (max 5) | `JournalingWorkflow` (COMPLETED branch) |
| `sync_schedule` | **not a workflow activity** — pure service function | n/a | n/a | `updateCallSchedule` server action; runs in Next.js Node runtime via `@temporalio/client`. Listed here for catalogue completeness only. |

### 3.1 Python signatures

```python
# activities.py — signatures only.
# Each activity is a module-level `async def` decorated with @activity.defn.

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from temporalio import activity


# ─── Inputs / outputs ──────────────────────────────────────────────────────

@dataclass(frozen=True)
class JournalingWorkflowInput:
    user_id: str                 # User.id
    call_schedule_id: str        # CallSchedule.id (for audit/linking; not mutated here)
    scheduled_for: datetime      # UTC instant this run represents (entry_date source)


@dataclass(frozen=True)
class SyncScheduleInput:
    call_schedule_id: str        # used by the service-layer activity, not JournalingWorkflow


@dataclass(frozen=True)
class CreateCallSessionInput:
    user_id: str
    scheduled_for: datetime
    workflow_id: str             # pinned to CallSession.temporal_workflow_id


@dataclass(frozen=True)
class CreateCallSessionResult:
    call_session_id: str
    phone_number: str            # User.phone_number, E.164
    user_timezone: str           # carried forward to summarize prompt
    voice: str                   # User.voicePreference, e.g. "aura-2-thalia-en".
                                 # Threaded through to the bot for per-call TTS.
    user_name: str | None        # User.name (nullable). Threaded through to the
                                 # bot so the greeting + system prompt can address
                                 # the caller by name.


@dataclass(frozen=True)
class InitiateCallInput:
    call_session_id: str
    workflow_id: str             # Pipecat needs this for async-complete
    activity_id: str             # deterministic: f"await-call"
    to_phone: str                # E.164
    voice: str                   # passed through to bot's POST /calls payload
    user_name: str | None        # passed through to bot's POST /calls payload


@dataclass(frozen=True)
class InitiateCallResult:
    twilio_call_sid: str


class CallOutcomeStatus(str, Enum):
    COMPLETED = "COMPLETED"
    NO_ANSWER = "NO_ANSWER"
    FAILED = "FAILED"


@dataclass(frozen=True)
class CallOutcome:
    status: CallOutcomeStatus
    call_session_id: str
    twilio_call_sid: str               # populated by the bot from the Twilio API;
                                       # empty string on workflow-side failure
                                       # constructions (initiate_call rejection,
                                       # await_call backstop) where there is no
                                       # call SID to record.
    transcript_text: str | None        # present iff COMPLETED
    transcript_segments: list | None   # present iff COMPLETED
    transcript_provider: str = "DEEPGRAM"
                                       # Value of Prisma's TranscriptProvider enum.
                                       # Seeded by the bot's `stt_factory.make_stt()`
                                       # via `TranscriptCollector(provider=...)`
                                       # (`pipecat-pipeline.md` §7.5, §9). Read by
                                       # `store_entry` when writing the Transcript
                                       # row's `provider` column. Default keeps
                                       # backwards-compat for failure-path
                                       # constructions in the workflow body that
                                       # don't go through the bot's collector.
    started_at: datetime | None        # bot fetches via twilio.calls(sid).fetch()
    ended_at: datetime | None
    duration_seconds: int | None
    failure_reason: str | None         # present iff FAILED / NO_ANSWER
    recording_url: str | None          # present iff COMPLETED and recording succeeded.
                                       # Twilio recording URL — looked up by Pipecat
                                       # via twilio.recordings.list(call_sid=...) at
                                       # pipeline end. Persisted to
                                       # call_sessions.recording_url by store_entry,
                                       # later read by canonicalize_transcript
                                       # (transcription-interface.md §5.3).


@dataclass(frozen=True)
class SummarizeInput:
    transcript_text: str
    user_timezone: str
    entry_date: str                    # "2026-04-24"


@dataclass(frozen=True)
class SummarizeResult:
    title: str
    body: str


@dataclass(frozen=True)
class StoreEntryInput:
    user_id: str
    call_session_id: str
    outcome: CallOutcome
    summary: SummarizeResult | None    # None for NO_ANSWER / FAILED branches


# ─── Activity definitions ──────────────────────────────────────────────────

# NOTE: `sync_schedule` is NOT a Temporal activity (no @activity.defn). It's a
# plain async function in the Next.js codebase, called from the
# `updateCallSchedule` server action via @temporalio/client. Kept in this
# pseudocode block for shape continuity with the activity inputs above; actual
# implementation lives in app/actions/call-schedule.ts.
async def sync_schedule(inp: SyncScheduleInput) -> None:
    """Idempotently reconcile the DB `call_schedules` row with its Temporal Schedule.
    Invoked ONLY from the `updateCallSchedule` server action (§4), not from the
    per-fire workflow — by the time JournalingWorkflow runs, the schedule already
    fired, so reconciling here would be circular and pointless."""


@activity.defn
async def create_call_session(inp: CreateCallSessionInput) -> CreateCallSessionResult:
    """Read the user row, INSERT into `call_sessions` with status=PENDING,
    and return enough context for the remaining activities so they don't
    each need to re-query. The fields read from `User` are:
      - phoneNumber (where to call)
      - timezone    (passed to summarize for entry-date context)
      - voicePreference (Deepgram Aura voice, threaded to bot)
      - name        (nullable; threaded to bot for greeting + prompt)"""


@activity.defn
async def initiate_call(inp: InitiateCallInput) -> InitiateCallResult:
    """POST /calls to the Pipecat server with payload:
        {workflow_id, activity_id, call_session_id, phone_number,
         voice, user_name}.
    The bot stores `voice` and `user_name` on its in-process CallCorrelation
    and uses them to construct the per-call pipeline once the WSS connects.
    Updates CallSession.status=DIALING and stores twilio_call_sid. Returns
    the call SID."""


@activity.defn
async def await_call(call_session_id: str) -> CallOutcome:
    """ASYNC-COMPLETED. The body is essentially:

        from temporalio.activity import raise_complete_async
        raise raise_complete_async()

    CRITICAL: `raise_complete_async()` RETURNS an exception that you must
    RAISE. Calling it bare (e.g., `raise_complete_async()` with no `raise`)
    silently returns None — the activity completes normally with None as
    the result, the workflow proceeds past `await_call` immediately, and
    the external completer never has anything to drive. Silent deadlock
    shaped like 'why did summarize get None?'.

    Once raised, the activity is completed externally by:
      (a) Pipecat on normal session end via Temporal SDK
          `get_async_activity_handle(wf_id, activity_id).complete(payload)`, OR
      (b) the Twilio statusCallback webhook on abnormal termination
          (no-answer, failed, busy, or canceled).
    Whichever fires first wins; the second is a no-op (already-completed).

    The activity itself does no DB work — the completer passes the full
    CallOutcome payload."""


@activity.defn
async def handle_missed_call(inp: StoreEntryInput) -> None:
    """Writes CallSession.status = NO_ANSWER | FAILED and optionally emits a
    minimal 'we couldn't reach you' journal entry. Called instead of
    summarize+store_entry for non-COMPLETED outcomes."""


@activity.defn
async def summarize(inp: SummarizeInput) -> SummarizeResult:
    """OpenRouter → anthropic/claude-sonnet-4-6. Returns title + body.
    Uses prompt caching for the system prompt (stable across calls)."""


@activity.defn
async def store_entry(inp: StoreEntryInput) -> None:
    """Transactionally: UPSERT the REALTIME Transcript row, UPDATE
    CallSession (status=COMPLETED, started_at, ended_at,
    duration_seconds, recording_url, twilio_call_sid), and INSERT a
    JournalEntry if a summary is present.

    `recording_url` is sourced from `inp.outcome.recording_url`,
    populated by Pipecat's `build_outcome` from
    `twilio.recordings.list(call_sid=...)`. May be None if the
    recording never landed (rare; canonical transcription will be
    skipped in that case).

    `Transcript.provider` is sourced from `inp.outcome.transcript_provider`,
    not hardcoded. The bot is the source of truth for which STT actually
    ran (seeded by `stt_factory.make_stt()` —
    `pipecat-pipeline.md` §7.5)."""
```

### 3.2 Workflow body

```python
# workflows.py — signature + control flow only.

from datetime import timedelta
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError

with workflow.unsafe.imports_passed_through():
    from .activities import (
        create_call_session, initiate_call, await_call,
        handle_missed_call, summarize, store_entry,
        CreateCallSessionInput, InitiateCallInput,
        SummarizeInput, StoreEntryInput,
        CallOutcome, CallOutcomeStatus, JournalingWorkflowInput,
    )
from temporalio.exceptions import ActivityError


# Default policy. NOTE: do NOT list "ApplicationError" in non_retryable_error_types —
# Temporal already honors the `non_retryable=True` flag on individual
# ApplicationError instances. Listing the base type here would make ALL
# ApplicationErrors non-retryable and defeat the flag.
_DEFAULT_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=30),
    maximum_attempts=3,
)

_INITIATE_CALL_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=2),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=10),
    maximum_attempts=3,
    non_retryable_error_types=["TwilioClientError"],  # 4xx from Twilio are fatal
)

_SUMMARIZE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    backoff_coefficient=1.0,   # fixed interval, not exponential
    maximum_interval=timedelta(seconds=10),
    maximum_attempts=2,
)
# MVP policy: one quick retry, then fail. 3× exponential (5→60s) held the
# worker slot for up to 65s of wait time; at 4-concurrent capacity that's
# noticeable if OpenRouter rate-limits systematically. Failed summary →
# workflow fails → no journal entry for that call. Acceptable MVP
# degradation; revisit if summary-failure rate exceeds ~1%.


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


@workflow.defn(name="JournalingWorkflow")
class JournalingWorkflow:
    @workflow.run
    async def run(self, inp: JournalingWorkflowInput) -> None:
        wf_id = workflow.info().workflow_id

        # Step 0 — Temporal Schedule firings can't reference the actual fire
        # time in their static args template, so the schedule passes
        # `scheduled_for=epoch` as a sentinel. Substitute `workflow.now()`
        # when we see it so DB rows + summary entry_date get sensible values.
        # The manual-trigger path in `triggerTestCall` passes the real time
        # and skips this branch.
        scheduled_for = (
            inp.scheduled_for if inp.scheduled_for > _EPOCH else workflow.now()
        )

        # Step 1 — create DB row, capture phone + timezone
        session = await workflow.execute_activity(
            create_call_session,
            CreateCallSessionInput(
                user_id=inp.user_id,
                scheduled_for=scheduled_for,
                workflow_id=wf_id,
            ),
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=_DEFAULT_RETRY,
        )

        # Step 2 — kick off the call.
        # `voice` and `user_name` ride through from create_call_session so the
        # bot can construct the per-call pipeline with the user's preferred
        # Aura voice and address them by name in the greeting + system prompt.
        #
        # Wrapped in try/except so a Twilio rejection (4xx → non-retryable
        # `TwilioClientError`, or 5xx after retries exhaust) routes straight
        # to `handle_missed_call`. Without this, the workflow would die with
        # an unhandled `ActivityError`, leaving the CallSession stuck in
        # PENDING. The bot's `POST /calls` forwards Twilio's HTTP status code
        # via `TwilioRestException` handling (`pipecat-pipeline.md` §2.3) so
        # `initiate_call` can classify retryability correctly.
        try:
            await workflow.execute_activity(
                initiate_call,
                InitiateCallInput(
                    call_session_id=session.call_session_id,
                    workflow_id=wf_id,
                    activity_id="await-call",      # deterministic, below
                    to_phone=session.phone_number,
                    voice=session.voice,
                    user_name=session.user_name,
                ),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=_INITIATE_CALL_RETRY,
            )
        except ActivityError as e:
            outcome = CallOutcome(
                status=CallOutcomeStatus.FAILED,
                call_session_id=session.call_session_id,
                twilio_call_sid="",
                failure_reason=(
                    f"initiate_call: "
                    f"{type(e.cause).__name__ if e.cause else type(e).__name__}"
                ),
            )
            await workflow.execute_activity(
                handle_missed_call,
                StoreEntryInput(
                    user_id=inp.user_id,
                    call_session_id=session.call_session_id,
                    outcome=outcome,
                    summary=None,
                ),
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=_DEFAULT_RETRY,
            )
            return

        # Step 3 — wait for the call to end (async completion).
        # activity_id pinned so Pipecat AND the watchdog webhook can complete it
        # without needing to persist a task_token.
        #
        # Backstop: if the 20-min start_to_close_timeout fires (Pipecat crashed
        # AND the Twilio statusCallback watchdog also failed to complete it),
        # degrade to FAILED rather than propagating ActivityError up — we still
        # want handle_missed_call to run so the CallSession row is marked.
        try:
            outcome = await workflow.execute_activity(
                await_call, session.call_session_id,
                activity_id="await-call",
                start_to_close_timeout=timedelta(minutes=20),
                retry_policy=RetryPolicy(maximum_attempts=1),  # no retry — see §6
            )
        except ActivityError as e:
            # Covers ActivityTimeoutError and any infra-level failure to
            # complete. Business outcomes (NO_ANSWER) come back as CallOutcome
            # return values, not exceptions — see decision #9.
            outcome = CallOutcome(
                status=CallOutcomeStatus.FAILED,
                call_session_id=session.call_session_id,
                transcript_text=None,
                transcript_segments=None,
                duration_seconds=None,
                failure_reason=f"await_call backstop: {type(e).__name__}",
            )

        # Step 4 — branch on outcome
        if outcome.status != CallOutcomeStatus.COMPLETED:
            await workflow.execute_activity(
                handle_missed_call,
                StoreEntryInput(
                    user_id=inp.user_id,
                    call_session_id=session.call_session_id,
                    outcome=outcome,
                    summary=None,
                ),
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=_DEFAULT_RETRY,
            )
            return

        # Step 5 — summarize + store
        summary = await workflow.execute_activity(
            summarize,
            SummarizeInput(
                transcript_text=outcome.transcript_text,
                user_timezone=session.user_timezone,
                entry_date=scheduled_for.date().isoformat(),
            ),
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=_SUMMARIZE_RETRY,
        )

        await workflow.execute_activity(
            store_entry,
            StoreEntryInput(
                user_id=inp.user_id,
                call_session_id=session.call_session_id,
                outcome=outcome,
                summary=summary,
            ),
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=_DEFAULT_RETRY,
        )
```

## 4. Schedule creation pattern

One **Temporal Schedule** per `CallSchedule` row. Owned by a service method, not by the workflow itself.

**Where it lives:** the `updateCallSchedule` Server Action runs in Next.js's Node.js runtime (TypeScript), so the actual implementation uses **`@temporalio/client` (TypeScript)**, not the Python SDK. The Python pseudocode below is presented for type-clarity continuity with the rest of this doc — names, arguments, and ordering map 1:1 to the TS implementation in `app/actions/call-schedule.ts`. Python types like `ScheduleSpec`, `ScheduleCalendarSpec`, `ScheduleActionStartWorkflow` correspond to TS classes of the same name in `@temporalio/client`. The same SDK is used by `/api/webhooks/twilio/call-status` to async-complete the `await-call` activity (§5).

```python
# Pseudocode. Actual code: app/actions/call-schedule.ts (TypeScript / @temporalio/client).
# Encapsulates "DB + Temporal atomic write".

async def upsert_call_schedule(
    user_id: str,
    local_time_of_day: str,   # "21:00"
    timezone: str,            # IANA, e.g. "America/Chicago"
    enabled: bool,
) -> None:
    """
    1. UPSERT `call_schedules` row → capture id
    2. Build ScheduleSpec. KEY: `time_zone_name` lives on ScheduleSpec
       (not on ScheduleCalendarSpec). Calendars only carry field matchers:
           spec = ScheduleSpec(
               calendars=[ScheduleCalendarSpec(hour=[ScheduleRange(21)],
                                                minute=[ScheduleRange(0)])],
               time_zone_name=timezone,   # IANA, e.g. "America/Chicago"
           )
       Temporal applies wall-clock semantics; DST handled natively.

    3. If row had `temporal_schedule_id` already:
         await client.get_schedule_handle(id).update(...)
       else:
         handle = await client.create_schedule(
             id=f"journal:{user_id}",    # human-stable; unique per user
             schedule=Schedule(
                 action=ScheduleActionStartWorkflow(
                     JournalingWorkflow.run,
                     JournalingWorkflowInput(
                         user_id=user_id,
                         call_schedule_id=row.id,
                         scheduled_for=<derived in workflow from workflow.info().start_time>,
                     ),
                     # Base workflow ID. Temporal AUTOMATICALLY appends the
                     # scheduled fire time (ISO-8601, second precision) when
                     # the schedule fires, producing e.g.
                     #   "journal-user_abc-2026-04-24T21:00:00Z"
                     # This is what makes per-fire IDs unique. Do NOT try to
                     # template {workflow.runId} here — the Python SDK has no
                     # such templating; the uniqueness comes from the auto-
                     # appended timestamp.
                     id=f"journal-{user_id}",
                     task_queue="quotid-main",
                 ),
                 spec=spec,
                 policy=SchedulePolicy(
                     overlap=ScheduleOverlapPolicy.SKIP,   # if last run still going, skip
                     catchup_window=timedelta(minutes=10), # miss by >10m → skip
                     pause_on_failure=False,               # one bad call shouldn't stop nightly
                 ),
                 state=ScheduleState(paused=not enabled),
             ),
         )
         UPDATE `call_schedules` SET temporal_schedule_id = handle.id
    """
```

**Key choices:**
- **Schedule ID = `journal:{user_id}`** — human-stable, one per user, easy to find in Temporal UI.
- **Workflow ID = `journal-{user_id}` + auto-appended fire time** — Temporal handles per-fire uniqueness. Decision in §7.
- **IANA tz on `ScheduleSpec`, not the calendar** — subtle SDK placement; gets DST right without manual offset math. Decision #10.
- **`ScheduleOverlapPolicy.SKIP`** — if a nightly run is somehow still executing when the next fire arrives (e.g., 20-minute call plus summary delay pushed past 21:00 next day — unlikely), skip rather than stack. Note: this is *schedule-level* only. Manual triggers via `triggerTestCall` bypass this; they can run concurrently with a scheduled fire. Fine for testing, document for operators.
- **`catchup_window=10min`** — if worker was down during fire window, run on recovery, but not if >10 min late (stale).

## 5. Watchdog pattern

Twilio `statusCallback` fires on call lifecycle. The webhook is the safety net for "Pipecat crashed or got wedged, never completed the activity."

```
┌──────────┐  POST  ┌────────────────────────────┐
│ Twilio   │──────► │ /api/webhooks/twilio/      │ (Next.js Route Handler)
│          │        │  call-status               │
└──────────┘        └────────────────────────────┘
                           │
                           │ 1. verify Twilio signature
                           │ 2. branch on CallStatus:
                           │
                           │   ─ "in-progress" (answered):
                           │       UPDATE call_sessions
                           │         SET status='IN_PROGRESS',
                           │             startedAt=NOW()
                           │         WHERE twilioCallSid=? AND
                           │               status IN ('DIALING','PENDING')
                           │       (workflow not signalled — dashboard polls)
                           │
                           │   ─ "no-answer" / "failed" / "busy" / "canceled":
                           │       SELECT call_sessions WHERE twilio_call_sid=?
                           │         → workflow_id
                           ▼
                   ┌────────────────────────────┐
                   │ temporal_client            │
                   │  .activity.complete(       │
                   │     {workflowId,           │
                   │      activityId:           │
                   │       "await-call"},       │
                   │     {status: NO_ANSWER,    │
                   │      failure_reason: ...}) │
                   └────────────────────────────┘
                           │
                           ▼
                   Workflow resumes, takes the
                   NO_ANSWER branch.
```

**Why this works without coordination:**
- `activity_id` is deterministic (`"await-call"`) — the webhook constructs the handle from `(workflow_id, "await-call")` without needing DB state or a stored task token.
- Temporal **`complete()` on an already-completed activity raises `AsyncActivityNotFoundError`** — the webhook swallows that, because it means Pipecat got there first, which is the happy path.
- **The webhook is silent on `completed` unless AMD says machine.** Forwarding *every* `completed` to Temporal races against the bot's `complete_await_call` (which builds the full outcome — segments + Twilio metadata round-trips — and takes ~5–10 s). Twilio fires `completed` the instant the leg ends, before the bot finalizes; if the webhook unconditionally completed, it would stomp the bot's outcome with a NO_ANSWER and skip the journal entry.

**Webhook decision matrix on `CallStatus`:**

| `CallStatus` | `AnsweredBy` | Action |
|---|---|---|
| `in-progress` | any | UPDATE CallSession SET status='IN_PROGRESS', startedAt=NOW() WHERE status IN ('DIALING','PENDING'). Workflow not signalled — dashboard polls. |
| `no-answer` / `failed` / `busy` / `canceled` | any | `client.activity.complete({...}, {NO_ANSWER \| FAILED, failure_reason: "twilio:<status>"})`. |
| `completed` | `machine_*` / `fax` | `client.activity.complete({...}, {NO_ANSWER, failure_reason: "twilio:answered_by_<value>"})`. The `/twiml` handler returned `<Hangup/>` (`pipecat-pipeline.md` §2.2), so no WSS opened and the bot is not the authoritative completer for this call. |
| `completed` | `human` / `unknown` / unset | **No-op.** The bot's WSS handler is authoritative — it'll complete the activity with the full transcript-bearing outcome. |
| Any other status | any | No-op. |

`busy` maps to `NO_ANSWER`; `canceled` maps to `FAILED` (see `STATUS_MAP` in the route handler). The `completed` no-op branch is the critical race-avoidance invariant — earlier versions raced on every `completed` event.

**The `in-progress` ("answered") status is also handled, but not by completing the activity.** When Twilio reports `CallStatus=in-progress`, the webhook flips `CallSession.status` from `DIALING` (or `PENDING`) to `IN_PROGRESS` and stamps `startedAt = now()`. The workflow doesn't directly observe this — it's still blocked on `await_call` — but the row mutation is visible to the Next.js dashboard, which polls and flips the "Calling…" banner to "Live." This is an out-of-band side effect on shared state; the workflow trusts the eventual `complete()` from Pipecat (or a watchdog path) to drive its own progress.

**Signature (Next.js Route Handler, TypeScript):**

```ts
// app/api/webhooks/twilio/call-status/route.ts
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. verify X-Twilio-Signature against externally-reconstructed URL
  //    (x-forwarded-proto + x-forwarded-host — internal req.url is wrong
  //    behind cloudflared/Caddy)
  // 2. parse form-encoded body → { CallSid, CallStatus, CallDuration, ... }
  // 3. branch (see decision matrix above):
  //    - CallStatus="in-progress": flip CallSession to IN_PROGRESS,
  //      stamp startedAt; do NOT signal Temporal (workflow stays in
  //      await_call until normal end or abnormal-status path below)
  //    - CallStatus in {"no-answer","failed","busy","canceled"}: lookup
  //      workflow_id and call client.activity.complete with a NO_ANSWER
  //      or FAILED outcome
  //    - CallStatus="completed" AND AnsweredBy in {machine_*, fax}:
  //      complete with NO_ANSWER (the /twiml handler hung up; bot is
  //      not the authoritative completer for this call)
  //    - CallStatus="completed" with human/unknown/unset AnsweredBy:
  //      no-op (Pipecat WSS handler is the source of truth for the
  //      transcript-bearing outcome and gets ~5–10s to finalize)
  // 4. always return 2xx fast (Twilio retries 5xx)
}
```

Temporal client access from Next.js: use the TypeScript SDK (`@temporalio/client`) against the same Temporal server. The worker is Python, the client can be any language.

## 6. Error taxonomy

Temporal retries **`Exception`** by default and does NOT retry **`ApplicationError(non_retryable=True)`**. Use this to distinguish:

| Class | Examples | Action |
|---|---|---|
| Transient | network blip, Deepgram 502, Neon pool exhausted | raise normal exception → retry per policy |
| Fatal — data | invalid phone number, user not found, malformed input | raise `ApplicationError(..., non_retryable=True)` → fail workflow immediately |
| Fatal — 4xx | Twilio 4xx, OpenRouter 400 | wrap as `ApplicationError(..., non_retryable=True)` |
| **Business outcome** | user didn't pick up, call failed at Twilio layer | **return `CallOutcome`**, do NOT raise — decision #9 |

The key subtlety: **"user didn't pick up" is a return value, not an exception.** Retrying a call that went unanswered would be user-hostile (double-ringing). The workflow branches on `outcome.status`.

## 7. Idempotency & correlation keys

Two workflow entry paths, each with its own ID scheme. The scheduled path inherits Temporal's auto-appended ISO-8601 fire timestamp (second precision); the manual path constructs its own second-precision suffix. Multiple runs per day — which happen constantly during development and testing — never collide.

| Correlation | Where | Why |
|---|---|---|
| `workflow_id` (scheduled) = `journal-{user_id}` + Temporal-appended ISO-8601 fire time | Temporal + `call_sessions.temporal_workflow_id` | Temporal auto-appends the scheduled fire time (second precision) to the schedule action's base ID. Final form: `journal-{user_id}-2026-04-24T21:00:00Z`. Unique per fire, searchable in Temporal UI. |
| `workflow_id` (manual) = `journal-{user_id}-manual-{YYYYMMDDTHHMMSS}` | `triggerTestCall` server action | **Second-precision** suffix — the manual-trigger path expects rapid-fire testing (click, listen, click again in seconds); minute-precision made back-to-back triggers collide. Clear `-manual-` marker distinguishes test runs from scheduled fires in the Temporal UI. |
| `activity_id = "await-call"` | Temporal + hardcoded in worker/Pipecat/webhook | No DB lookup needed to construct async handle. Unique within a workflow (only one async activity), collision-free across workflows because `get_async_activity_handle` scopes by `(workflow_id, activity_id)`. |
| `twilio_call_sid` | Twilio + `call_sessions.twilio_call_sid` (`@unique`) | Webhook dedup. Twilio retries the webhook; second write hits unique constraint → return 200. |
| `call_session_id` | passed through all post-call activities | Activities don't re-query by workflow_id. |

**Why second-precision for the manual path**: `triggerTestCall` is the primary way to exercise the system during development — expect users to click "Ring me now," listen for a few seconds, then click it again to retry with different input. Minute-precision made back-to-back triggers fail with `WorkflowAlreadyStartedError`, which is friction for the primary testing workflow. Seconds give >60× the collision headroom at negligible cost in Temporal UI readability. Collisions within the same second are still possible in theory but require sub-second click speed.

**Why no explicit `WorkflowIDReusePolicy.REJECT_DUPLICATE`**: the timestamp suffix already guarantees uniqueness per minute. Default policy (`ALLOW_DUPLICATE`) is fine.

## 8. Timeout summary

| Boundary | Value | Rationale |
|---|---|---|
| `await_call.start_to_close_timeout` | 20 min | Longest reasonable journaling call. Backstop, not expected to fire. |
| `summarize.start_to_close_timeout` | 2 min | Sonnet on a 10-min transcript is ~5–15 s typical; 2 min covers tail. |
| `initiate_call.start_to_close_timeout` | 30 s | POST /calls → Pipecat → Twilio `calls.create` is a fast synchronous hop. |
| Workflow `execution_timeout` | 30 min | Hard cap; prevents runaway runs from eating worker slots indefinitely. |
| Schedule `catchup_window` | 10 min | Late-firing tolerance. |

## 9. Open questions (defer until Step 5 or implementation)

1. **Where does Pipecat send the transcript on completion?** — Directly in the `complete()` payload (kilobytes, fine for Temporal), or write to Neon first and pass only `call_session_id`? Leaning inline for simplicity; revisit if payloads exceed ~256 KB.
2. **Does `handle_missed_call` write a journal entry or not?** — Low-value entries cluttering the list. MVP: do NOT write a `JournalEntry` for NO_ANSWER; only update `CallSession.status`. Reconsider if user wants a visible "missed" entry on the timeline.
3. **Schedule pause/resume UX** — Server action `updateCallSchedule` with `enabled=false` pauses the Temporal Schedule. Confirm the UI exposes a toggle; if not, defer.

---

**Step 3 status:** design locked. Ready for Step 4 (finish API contract → OpenAPI spec) or, if user prefers, move straight to scaffolding since this doc + §3.1 signatures are already implementation-ready.
