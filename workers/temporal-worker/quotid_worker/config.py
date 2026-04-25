import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.environ.get("DOTENV_PATH", "../../.env"))


@dataclass(frozen=True)
class Config:
    temporal_address: str = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
    temporal_namespace: str = os.environ.get("TEMPORAL_NAMESPACE", "default")
    bot_public_url: str = os.environ.get("BOT_PUBLIC_URL", "http://localhost:8000")
    bot_internal_url: str = os.environ.get("BOT_INTERNAL_URL", "http://localhost:8000")
    task_queue: str = "quotid-main"


CONFIG = Config()
