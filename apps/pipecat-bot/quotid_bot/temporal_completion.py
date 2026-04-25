from typing import Any

from loguru import logger
from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.exceptions import ApplicationError
from temporalio.service import RPCError

from .config import CONFIG


_client: Client | None = None


async def get_client() -> Client:
    global _client
    if _client is None:
        _client = await Client.connect(
            CONFIG.temporal_address,
            namespace=CONFIG.temporal_namespace,
            data_converter=pydantic_data_converter,
        )
    return _client


async def complete_await_call(workflow_id: str, payload: dict[str, Any]) -> None:
    client = await get_client()
    handle = client.get_async_activity_handle(
        workflow_id=workflow_id,
        activity_id="await-call",
    )
    try:
        await handle.complete(payload)
    except RPCError as e:
        logger.warning(f"complete_await_call: {workflow_id} already finalized: {e}")


async def fail_await_call(workflow_id: str, reason: str) -> None:
    client = await get_client()
    handle = client.get_async_activity_handle(
        workflow_id=workflow_id,
        activity_id="await-call",
    )
    try:
        await handle.fail(ApplicationError(reason, type="BotError"))
    except RPCError as e:
        logger.warning(f"fail_await_call: {workflow_id} already finalized: {e}")
