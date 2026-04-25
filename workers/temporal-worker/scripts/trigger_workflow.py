"""One-off helper to kick off a JournalingWorkflow.

Usage: uv run python scripts/trigger_workflow.py <user_id>
"""

import asyncio
import sys
from datetime import datetime, timezone

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter

from quotid_worker.config import CONFIG
from quotid_worker.dto import JournalingWorkflowInput


async def main(user_id: str) -> None:
    now = datetime.now(timezone.utc)
    client = await Client.connect(
        CONFIG.temporal_address,
        namespace=CONFIG.temporal_namespace,
        data_converter=pydantic_data_converter,
    )
    workflow_id = f"journal-{user_id}-manual-{now.strftime('%Y%m%dT%H%M%S')}"
    handle = await client.start_workflow(
        "JournalingWorkflow",
        JournalingWorkflowInput(
            user_id=user_id,
            scheduled_for=now,
        ),
        id=workflow_id,
        task_queue=CONFIG.task_queue,
    )
    print(f"Started: {handle.id}")
    result = await handle.result()
    print(f"Result: {result}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
