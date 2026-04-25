from twilio.request_validator import RequestValidator
from .config import CONFIG

_validator = RequestValidator(CONFIG.twilio_auth_token)


def verify(url: str, params: dict[str, str] | str, signature: str | None) -> bool:
    if not signature:
        return False
    return _validator.validate(url, params, signature)
