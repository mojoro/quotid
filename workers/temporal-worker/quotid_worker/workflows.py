from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from .activities import create_call_session
    from .dto import (
        CreateCallSessionInput,
        JournalingWorkflowInput,
    )


@workflow.defn(name="JournalingWorkflow")
class JournalingWorkflow:
    @workflow.run
    async def run(self, inp: JournalingWorkflowInput) -> str:
        result = await workflow.execute_activity(
            create_call_session,
            CreateCallSessionInput(
                user_id=inp.user_id,
                scheduled_for=inp.scheduled_for,
                workflow_id=workflow.info().workflow_id,
            ),
            start_to_close_timeout=timedelta(seconds=10),
        )
        return result.call_session_id
