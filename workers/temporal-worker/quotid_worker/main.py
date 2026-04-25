import asyncio
import logging

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from .config import CONFIG
from .db import connect, disconnect
from .activities import (
    create_call_session,
    initiate_call,
    await_call,
    handle_missed_call,
    summarize,
    store_entry,
)
from .workflows import JournalingWorkflow


async def amain() -> None:
    logging.basicConfig(level=logging.INFO)

    await connect()

    client = await Client.connect(
        CONFIG.temporal_address,
        namespace=CONFIG.temporal_namespace,
        data_converter=pydantic_data_converter,
    )

    worker = Worker(
        client,
        task_queue=CONFIG.task_queue,
        workflows=[JournalingWorkflow],
        activities=[
            create_call_session,
            initiate_call,
            await_call,
            handle_missed_call,
            summarize,
            store_entry,
        ],
    )

    try:
        await worker.run()
    finally:
        await disconnect()


if __name__ == "__main__":
    asyncio.run(amain())
