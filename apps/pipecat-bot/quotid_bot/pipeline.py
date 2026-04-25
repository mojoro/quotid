from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.frames.frames import TextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .config import CONFIG
from .system_prompt import OPENING_LINE, SYSTEM_PROMPT
from .transcript_accumulator import TranscriptAccumulator


class QuotidDeepgramTTSService(DeepgramTTSService):
    """Empty subclass — swap point for future ModalTTSService (decision #11)."""


def build_pipeline(
    websocket,
    stream_sid: str,
    call_sid: str,
) -> tuple[PipelineTask, TranscriptAccumulator, LLMContext]:
    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        account_sid=CONFIG.twilio_account_sid,
        auth_token=CONFIG.twilio_auth_token,
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    stt = DeepgramSTTService(api_key=CONFIG.deepgram_api_key)

    llm = OpenAILLMService(
        api_key=CONFIG.openrouter_api_key,
        base_url="https://openrouter.ai/api/v1",
        model="anthropic/claude-haiku-4-5",
    )

    tts = QuotidDeepgramTTSService(
        api_key=CONFIG.deepgram_api_key,
        voice="aura-2-thalia-en",  # Aura 2 default; change via env if needed
    )

    context = LLMContext(messages=[{"role": "system", "content": SYSTEM_PROMPT}])
    accumulator = TranscriptAccumulator(context)

    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(
                params=VADParams(stop_secs=0.2, start_secs=0.2, confidence=0.7)
            ),
            user_turn_strategies=UserTurnStrategies(
                stop=[
                    TurnAnalyzerUserTurnStopStrategy(
                        turn_analyzer=LocalSmartTurnAnalyzerV3(),
                    )
                ],
            ),
        ),
    )

    pipeline = Pipeline([
        transport.input(),
        stt,
        accumulator,
        user_aggregator,
        llm,
        tts,
        transport.output(),
        assistant_aggregator,
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
            allow_interruptions=True,
            enable_metrics=True,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def kick_off(_t, _client):
        await task.queue_frames([TextFrame(OPENING_LINE)])

    return task, accumulator, context
