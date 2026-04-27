from datetime import datetime, timedelta, timezone

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

with workflow.unsafe.imports_passed_through():
    from .activities import (
        create_call_session,
        initiate_call,
        await_call,
        handle_missed_call,
        summarize,
        store_entry,
    )
    from .dto import (
        CallOutcome,
        CallOutcomeStatus,
        CreateCallSessionInput,
        InitiateCallInput,
        JournalingWorkflowInput,
        StoreEntryInput,
        SummarizeInput,
        SummarizeResult,
    )


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
    non_retryable_error_types=["TwilioClientError"],
)

_SUMMARIZE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    backoff_coefficient=1.0,
    maximum_interval=timedelta(seconds=10),
    maximum_attempts=2,
)


@workflow.defn(name="JournalingWorkflow")
class JournalingWorkflow:
    @workflow.run
    async def run(self, inp: JournalingWorkflowInput) -> str | None:
        wf_id = workflow.info().workflow_id

        # Temporal Schedule firings pass `scheduled_for: epoch` because the
        # Schedule's static args template can't reference the actual fire
        # time. Substitute the real time when we detect that sentinel so DB
        # rows + summary prompts get sensible dates.
        scheduled_for = (
            inp.scheduled_for if inp.scheduled_for > _EPOCH else workflow.now()
        )

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

        try:
            await workflow.execute_activity(
                initiate_call,
                InitiateCallInput(
                    call_session_id=session.call_session_id,
                    workflow_id=wf_id,
                    activity_id="await-call",
                    to_phone=session.phone_number,
                    voice=session.voice,
                    user_name=session.user_name,
                ),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=_INITIATE_CALL_RETRY,
            )
        except ActivityError as e:
            # Twilio rejected the call (4xx) or all retries exhausted (5xx).
            # Skip await_call and route straight to handle_missed_call so the
            # CallSession leaves PENDING rather than getting stuck there.
            outcome = CallOutcome(
                status=CallOutcomeStatus.FAILED,
                call_session_id=session.call_session_id,
                twilio_call_sid="",
                failure_reason=f"initiate_call: {type(e.cause).__name__ if e.cause else type(e).__name__}",
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
            return None

        try:
            outcome: CallOutcome = await workflow.execute_activity(
                await_call,
                session.call_session_id,
                activity_id="await-call",
                start_to_close_timeout=timedelta(minutes=20),
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
        except ActivityError as e:
            outcome = CallOutcome(
                status=CallOutcomeStatus.FAILED,
                call_session_id=session.call_session_id,
                twilio_call_sid="",
                failure_reason=f"await_call backstop: {type(e).__name__}",
            )

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
            return None

        summary: SummarizeResult = await workflow.execute_activity(
            summarize,
            SummarizeInput(
                transcript_text=outcome.transcript_text or "",
                user_timezone="UTC",
                entry_date=scheduled_for.date().isoformat(),
            ),
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=_SUMMARIZE_RETRY,
        )

        return await workflow.execute_activity(
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
