import uuid
from datetime import datetime, timezone

from temporalio import activity
from temporalio.worker import Worker

from quotid_worker.workflows import JournalingWorkflow
from quotid_worker.dto import (
    CreateCallSessionInput,
    CreateCallSessionResult,
    JournalingWorkflowInput,
)


@activity.defn(name="create_call_session")
async def stub_create_call_session(inp: CreateCallSessionInput) -> CreateCallSessionResult:
    return CreateCallSessionResult(
        call_session_id="cs_test",
        phone_number="+15555550100",
        user_timezone="UTC",
        voice="aura-2-thalia-en",
    )


async def test_workflow_invokes_create_call_session(env):
    client = env.client
    async with Worker(
        client,
        task_queue="test-queue",
        workflows=[JournalingWorkflow],
        activities=[stub_create_call_session],
    ):
        result = await client.execute_workflow(
            "JournalingWorkflow",
            JournalingWorkflowInput(
                user_id="user_123",
                scheduled_for=datetime(2026, 4, 25, 21, 0, tzinfo=timezone.utc),
            ),
            id=f"test-{uuid.uuid4()}",
            task_queue="test-queue",
        )
        assert result == "cs_test"
