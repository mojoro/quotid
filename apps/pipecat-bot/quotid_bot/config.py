import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.environ.get("DOTENV_PATH", "../../.env"))


@dataclass(frozen=True)
class Config:
    twilio_account_sid: str = os.environ.get("TWILIO_ACCOUNT_SID", "")
    twilio_auth_token: str = os.environ.get("TWILIO_AUTH_TOKEN", "")
    twilio_phone_number: str = os.environ.get("TWILIO_PHONE_NUMBER", "")
    deepgram_api_key: str = os.environ.get("DEEPGRAM_API_KEY", "")
    # STT/TTS chosen by env so swapping providers is a config change, not a
    # code change. Both *_API_KEY values fall back to DEEPGRAM_API_KEY so prod
    # env files don't have to migrate at the same time as the code.
    stt_provider: str = os.environ.get("STT_PROVIDER", "deepgram")
    stt_api_key: str = (
        os.environ.get("STT_API_KEY") or os.environ.get("DEEPGRAM_API_KEY", "")
    )
    tts_provider: str = os.environ.get("TTS_PROVIDER", "deepgram")
    tts_api_key: str = (
        os.environ.get("TTS_API_KEY") or os.environ.get("DEEPGRAM_API_KEY", "")
    )
    openrouter_api_key: str = os.environ.get("OPENROUTER_API_KEY", "")
    cartesia_api_key: str = os.environ.get("CARTESIA_API_KEY", "")
    cartesia_voice_id: str = os.environ.get("CARTESIA_VOICE_ID", "")
    bot_public_url: str = os.environ.get("BOT_PUBLIC_URL", "http://localhost:8000")
    app_public_url: str = os.environ.get("APP_PUBLIC_URL", "http://localhost:3000")
    temporal_address: str = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
    temporal_namespace: str = os.environ.get("TEMPORAL_NAMESPACE", "default")


CONFIG = Config()
