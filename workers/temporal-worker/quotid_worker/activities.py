from temporalio import activity

from .db import prisma
from .dto import CreateCallSessionInput, CreateCallSessionResult


@activity.defn
async def create_call_session(inp: CreateCallSessionInput) -> CreateCallSessionResult:
    """Read the user, create a CallSession row, and return phone+timezone."""

    user = await prisma.user.find_unique(where={"id": inp.user_id})
    if user is None:
        raise ValueError(f"User {inp.user_id} not found")

    cs = await prisma.callsession.create(
        data={
            "userId": user.id,
            "scheduledFor": inp.scheduled_for,
            "status": "PENDING",
            "temporalWorkflowId": inp.workflow_id,
        }
    )

    return CreateCallSessionResult(
        call_session_id=cs.id,
        phone_number=user.phoneNumber,
        user_timezone=user.timezone,
    )
