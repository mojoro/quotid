"""Factory for STT services. The single place that knows which provider runs.

Adding a new STT vendor is:
1. Add the Pipecat extra in `pyproject.toml` (e.g. `pipecat-ai[assemblyai]`).
2. Add a `case` here that builds the service and returns the matching label.
3. Add the label to Prisma's `TranscriptProvider` enum.
4. Set `STT_PROVIDER=<provider>` in the bot's env.

The label flows through `TranscriptCollector.build_outcome` → `CallOutcome` →
`store_entry` activity → `Transcript.provider` column. Worker code never
hardcodes which STT was used.
"""

from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.stt_service import STTService

from .config import CONFIG


def make_stt() -> tuple[STTService, str]:
    """Return (service, provider_label).

    The label is a value of Prisma's `TranscriptProvider` enum
    (`DEEPGRAM | WHISPERX | OTHER`). Adding a new label requires a Prisma
    migration as well as a new branch here.
    """
    provider = CONFIG.stt_provider.lower()
    match provider:
        case "deepgram":
            # Nova-3 is Deepgram's flagship streaming model — ~50% lower WER
            # than Nova-2 (Deepgram's prior default), particularly under noisy
            # phone-line conditions. Drop-in upgrade.
            #
            # Endpointing/utterance settings are explicit so the upgrade
            # reproduces deterministically when we later swap providers
            # (defaults differ across STT vendors).
            settings = DeepgramSTTService.Settings(
                model="nova-3-general",
                language="en-US",
                smart_format=True,
                punctuate=True,
                interim_results=True,
                endpointing=300,
                utterance_end_ms=1000,
            )
            return (
                DeepgramSTTService(api_key=CONFIG.stt_api_key, settings=settings),
                "DEEPGRAM",
            )
        case _:
            raise ValueError(f"unknown STT provider: {provider!r}")
