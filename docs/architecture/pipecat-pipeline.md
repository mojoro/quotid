# Pipecat Pipeline Design — Quotid

**Scope:** Step 5 of the design phase. Defines the per-call Pipecat pipeline inside the Bot Server: transport configuration, pipeline graph, turn detection, interruption handling, context aggregator pattern, audio format, TTS service hierarchy (Modal seam), and latency budget.

**Deliverable:** design doc + Python pseudocode. **No implementation.**

**Authoritative sources consumed:**
- `docs/SESSION_HANDOFF.md` — decisions #3, #7, #11, #12
- `docs/architecture/temporal-workflow.md` — §3 (activity catalogue), §5 (async completion)
- `docs/architecture/api/pipecat-bot.openapi.yaml` — `POST /calls`, TwiML, WSS endpoints
- `docs/architecture/likec4/quotid.c4` — `callFlow` / `callSequence` views

---

## 1. Overview

Each inbound WebSocket connection on `WSS /calls/{call_sid}/stream` spins up **one `Pipeline`** instance. The pipeline processes audio frames bidirectionally between Twilio and the STT/LLM/TTS services, running until the call ends. On normal completion, the Bot Server constructs a `CallOutcome` and completes the Temporal `await-call` activity.

**Process model:** single FastAPI process, one pipeline per active call. No worker pool, no queue — each WebSocket handler is its own async task. Concurrency limit = FastAPI's configured workers × connection limit (MVP: 1 worker, cap 4 concurrent calls).

**Key classes (all Pipecat unless noted):**

| Module | Class | Purpose |
|---|---|---|
| `pipecat.pipeline.pipeline` | `Pipeline` | Ordered list of `FrameProcessor`s. |
| `pipecat.pipeline.task` | `PipelineTask`, `PipelineParams` | Runs a `Pipeline`; owns audio params. |
| `pipecat.pipeline.runner` | `PipelineRunner` | Top-level driver for a `PipelineTask`. |
| `pipecat.transports.websocket.fastapi` | `FastAPIWebsocketTransport`, `FastAPIWebsocketParams` | Twilio-side I/O. |
| `pipecat.serializers.twilio` | `TwilioFrameSerializer` | Encodes/decodes Twilio Media Streams frames. |
| `pipecat.services.deepgram.stt` | `DeepgramSTTService` | Streaming STT (Nova-3). |
| `pipecat.services.openai` | `OpenAILLMService` | LLM — pointed at OpenRouter via custom `base_url`. |
| `pipecat.services.cartesia.tts` | `CartesiaTTSService` | Streaming TTS (Sonic). |
| `pipecat.audio.vad.silero` | `SileroVADAnalyzer` | Voice activity detection. |
| `pipecat.audio.vad.vad_analyzer` | `VADParams` | VAD tuning. |
| `pipecat.audio.turn.smart_turn.local_smart_turn_v3` | `LocalSmartTurnAnalyzerV3` | ML-based end-of-turn detector. |
| `pipecat.turns.user_stop` | `TurnAnalyzerUserTurnStopStrategy` | Wraps the turn analyzer as a strategy. |
| `pipecat.turns.user_turn_strategies` | `UserTurnStrategies` | Strategy composition for turn end. |
| `pipecat.processors.aggregators.llm_response_universal` | `LLMContextAggregatorPair`, `LLMUserAggregatorParams` | Builds user + assistant message aggregators from a shared `LLMContext`. |

## 2. Endpoint lifecycle

```
Temporal worker                    Pipecat server                    Twilio
     │                                    │                             │
     │ POST /calls { wf_id, act_id, ... } │                             │
     │ ─────────────────────────────────► │                             │
     │                                    │ twilio.calls.create(...)    │
     │                                    │ ──────────────────────────► │
     │                                    │ ◄────── { call_sid }        │
     │ ◄──── 201 { call_sid }             │                             │
     │                                    │                             │
     │ (worker's `initiate_call` activity │                             │
     │  returns; `await_call` starts      │                             │
     │  waiting for async completion)     │                             │
     │                                    │                             │
     │                                    │ ◄──────── GET /twiml ─────  │
     │                                    │ 200 <Connect><Stream/>      │
     │                                    │ ────────────────────────►   │
     │                                    │                             │
     │                                    │ ◄─ WSS /calls/{sid}/stream  │
     │                                    │    (build pipeline, run)    │
     │                                    │ ═══════════════════════════ │
     │                                    │    audio in/out frames      │
     │                                    │ ═══════════════════════════ │
     │                                    │                             │
     │                                    │ pipeline ends               │
     │                                    │ (user hangup or bot-end)    │
     │                                    │                             │
     │ ◄─── get_async_activity_handle     │                             │
     │        (wf_id, act_id).complete(   │                             │
     │          CallOutcome(...))         │                             │
     │                                    │                             │
     │ (workflow resumes, summarize → store_entry)                      │
```

Two distinct endpoints handle the call:
1. **`POST /calls`** — creates the Twilio call, returns quickly with `call_sid`. No pipeline built yet.
2. **`WSS /calls/{call_sid}/stream`** — Twilio initiates this after its `twiml_url` callback. This is where the pipeline lives.

They share state via an in-process registry keyed by `call_sid`: `{call_sid -> {workflow_id, activity_id, call_session_id}}`. When the WSS handler accepts a connection, it looks up the correlation IDs it needs to complete the Temporal activity later. This is ephemeral memory — if the Bot Server restarts, in-flight calls are lost, the Temporal watchdog (`/api/webhooks/twilio/call-status`) handles that case.

**Single-worker requirement:** this registry lives in one Python process's memory. The Bot Server MUST run with `uvicorn --workers=1` (or gunicorn equivalent). Multi-worker setups would route the `POST /calls` and the `WSS /calls/{sid}/stream` to different workers, each with an empty registry. If horizontal scaling becomes necessary, move the registry to Redis keyed by `call_sid` with a 1-hour TTL — but MVP concurrency cap is 4 calls, well within one worker's capacity.

## 3. Pipeline graph

```
┌─────────────────────────┐
│ FastAPIWebsocketTransport (input)                              │
│   · reads Twilio Media Streams frames                          │
│   · decodes via TwilioFrameSerializer (μ-law 8kHz → PCM)       │
└───────────────┬─────────────────────────────────────────────────┘
                │ AudioRawFrame
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ DeepgramSTTService                                              │
│   · streams audio over WSS to Deepgram                          │
│   · emits TranscriptionFrame (interim + final) per turn         │
└───────────────┬─────────────────────────────────────────────────┘
                │ TranscriptionFrame (final only, after aggregator)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ user_aggregator (from LLMContextAggregatorPair)                 │
│   · VAD (Silero): speech-activity gate                          │
│   · SmartTurn: end-of-turn classifier                           │
│   · buffers user transcripts into LLMContext.messages           │
│   · emits LLMMessagesFrame on turn end                          │
└───────────────┬─────────────────────────────────────────────────┘
                │ LLMMessagesFrame
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ OpenAILLMService (pointed at OpenRouter)                        │
│   · model: anthropic/claude-haiku-4-5                           │
│   · streams tokens → emits TextFrame + LLMFullResponseStartFrame│
│                     / LLMFullResponseEndFrame                   │
└───────────────┬─────────────────────────────────────────────────┘
                │ TextFrame (streaming)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ CartesiaTTSService                                              │
│   · streams incoming text → synthesized PCM audio               │
│   · emits AudioRawFrame                                         │
└───────────────┬─────────────────────────────────────────────────┘
                │ AudioRawFrame
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ FastAPIWebsocketTransport (output)                              │
│   · encodes via TwilioFrameSerializer (PCM → μ-law 8kHz)        │
│   · writes Twilio Media Streams frames                          │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ assistant_aggregator (from LLMContextAggregatorPair)            │
│   · buffers assistant response text into LLMContext.messages    │
│   · ensures next user turn has full conversation history        │
└─────────────────────────────────────────────────────────────────┘
```

**Why `assistant_aggregator` is AFTER `transport.output()`**: the assistant aggregator needs to know what was *actually sent to the user*, including any interruption-induced truncations. Placing it after output captures the final emitted text, not the pre-interruption LLM output. This is the canonical Pipecat pattern.

## 4. Pipeline assembly (Python pseudocode)

```python
# apps/pipecat-bot/src/bot.py — signatures + structure only.

import os
from fastapi import WebSocket
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair, LLMUserAggregatorParams,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai import OpenAILLMService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams, FastAPIWebsocketTransport,
)
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .correlation import pop_correlation          # {call_sid -> (wf_id, act_id, cs_id)}
from .completion import complete_await_call       # Temporal async-completion helper
from .tts import QuotidCartesiaTTSService         # see §7 — thin subclass for swap seam
from .prompts import SYSTEM_PROMPT


async def run_bot(websocket: WebSocket, stream_sid: str, call_sid: str) -> None:
    """
    Entry point invoked by the FastAPI WSS route handler. Runs until the
    pipeline ends (user hangup or bot-initiated end), then completes the
    corresponding Temporal activity with a CallOutcome payload.
    """
    corr = pop_correlation(call_sid)   # raises if call_sid was never registered

    # ── Transport: Twilio Media Streams over WSS ────────────────────────
    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        account_sid=os.environ["TWILIO_ACCOUNT_SID"],
        auth_token=os.environ["TWILIO_AUTH_TOKEN"],
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

    # ── Services ────────────────────────────────────────────────────────
    stt = DeepgramSTTService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        settings=DeepgramSTTService.Settings(
            model="nova-3-general",
            language="en",
            smart_format=True,
            punctuate=True,
            # Interim results feed VAD/SmartTurn's low-latency turn-detection
            # signals; the TranscriptAccumulator (§9) ignores non-final
            # TranscriptionFrames and only records final ones.
            interim_results=True,
        ),
    )

    llm = OpenAILLMService(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url="https://openrouter.ai/api/v1",
        settings=OpenAILLMService.Settings(
            model="anthropic/claude-haiku-4-5",
            temperature=0.7,
            max_completion_tokens=500,
        ),
    )

    tts = QuotidCartesiaTTSService(        # see §7
        api_key=os.environ["CARTESIA_API_KEY"],
        settings=CartesiaTTSService.Settings(
            voice=os.environ["CARTESIA_VOICE_ID"],
        ),
    )

    # ── Context + accumulator + aggregators ─────────────────────────────
    context = LLMContext(messages=[{"role": "system", "content": SYSTEM_PROMPT}])
    transcript_accumulator = TranscriptAccumulator(context)  # see §9 — reads assistant turns from context at pipeline end
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(
                stop_secs=0.2,    # short — SmartTurn does the real end-of-turn work
                start_secs=0.2,
                confidence=0.7,
            )),
            user_turn_strategies=UserTurnStrategies(
                stop=[TurnAnalyzerUserTurnStopStrategy(
                    turn_analyzer=LocalSmartTurnAnalyzerV3(),
                )],
            ),
            # `filter_incomplete_user_turns=True` intentionally NOT set:
            # it's an LLM-based turn-completion classifier that predates
            # SmartTurn and adds per-turn tokens + re-prompt latency.
            # SmartTurn (audio-based) alone is sufficient for MVP. Revisit
            # only if false-turn rate proves problematic.
        ),
    )

    # ── Pipeline ────────────────────────────────────────────────────────
    pipeline = Pipeline([
        transport.input(),
        stt,
        transcript_accumulator,       # siphons final transcripts for the outcome payload
        user_aggregator,
        llm,
        tts,
        transport.output(),
        assistant_aggregator,
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,    # decision #11: μ-law 8kHz on Twilio leg
            audio_out_sample_rate=8000,
            allow_interruptions=True,
            enable_metrics=True,
        ),
    )

    # ── Run ─────────────────────────────────────────────────────────────
    runner = PipelineRunner(handle_sigint=False)   # FastAPI owns signal handling
    try:
        await runner.run(task)
    finally:
        # Pipeline ended — build the outcome and complete the activity.
        outcome = await transcript_accumulator.build_outcome(
            call_session_id=corr.call_session_id,
            call_sid=call_sid,
            twilio_client=twilio_client,   # constructed at module load from env
        )
        await complete_await_call(
            workflow_id=corr.workflow_id,
            activity_id=corr.activity_id,
            outcome=outcome,
        )
```

`complete_await_call` is a thin wrapper over the Python Temporal client's `get_async_activity_handle(wf_id, act_id).complete(payload)`. It tolerates the already-completed case (webhook got there first) by catching `AsyncActivityNotFoundError` — matches the race-safe design in `docs/architecture/temporal-workflow.md` §5.

## 5. Audio format & transport config

Per decision #11:

| Leg | Format | Sample rate | Handled by |
|---|---|---|---|
| Twilio ↔ Pipecat WSS | μ-law encoded | 8 kHz | `TwilioFrameSerializer` (transparent) |
| Pipeline internal | Linear PCM (16-bit signed) | 8 kHz | Pipecat default once serializer decodes |
| Deepgram streaming input | Linear PCM | 8 kHz (passed through) | Deepgram handles upsampling internally if needed |
| Cartesia streaming output | Linear PCM | 8 kHz (we request) | Set via `CartesiaTTSService.Settings` if needed to match |

`PipelineParams(audio_in_sample_rate=8000, audio_out_sample_rate=8000)` tells Pipecat the wire format expected by the transport. The STT and TTS services adapt to the pipeline's PCM stream; they don't know or care about Twilio.

**What we give up by staying at 8 kHz:** a bit of TTS fidelity — Cartesia Sonic sounds better at 24 kHz. But telephony codecs downsample anyway; any extra bandwidth is discarded before the user hears it. 8 kHz end-to-end avoids one resampling step and ~10–20 ms of CPU-bound latency.

## 6. Turn detection

Two layered analyzers configured on the user aggregator:

| Layer | Class | Role | Latency contribution |
|---|---|---|---|
| **VAD** | `SileroVADAnalyzer` with `VADParams(stop_secs=0.2, start_secs=0.2, confidence=0.7)` | Gates speech-vs-silence at the frame level. Enables interruption: detects user speech during assistant TTS. | ~50 ms (ML inference per frame) |
| **Turn analyzer** | `LocalSmartTurnAnalyzerV3` wrapped in `TurnAnalyzerUserTurnStopStrategy` | Decides whether a VAD-detected pause is an actual *end of turn* vs a mid-sentence pause. Prevents false turn-triggers on conversational hesitations ("um", breath, thinking pause). | ~100–150 ms (small classifier on accumulated features) |

**Why short `stop_secs=0.2` on VAD when default is ~0.8:** SmartTurn is the authoritative end-of-turn signal. A long VAD stop window would stack on top of SmartTurn's own decision latency, double-paying for the same determination. Short VAD + SmartTurn is the recommended combo per Pipecat's Smart Turn docs.

**`filter_incomplete_user_turns=True`:** drops trailing audio that SmartTurn classifies as non-turn (e.g., a tail "...yeah" after the main thought). Prevents stray empty messages in the LLM context.

## 7. TTS service hierarchy — Modal seam (decision #7)

Per decision #7: "Pipecat's `TTSService` base class is sufficient for hosted-to-Modal swap. Subclass directly; no wrapper layer."

**Hierarchy:**

```
pipecat.services.tts.TTSService         (Pipecat abstract base)
└── pipecat.services.cartesia.tts.CartesiaTTSService   (Pipecat built-in)
    └── apps.pipecat-bot.src.tts.QuotidCartesiaTTSService   (our MVP subclass)

pipecat.services.tts.TTSService
└── apps.pipecat-bot.src.tts.ModalTTSService   (FUTURE — swap target)
```

`QuotidCartesiaTTSService` is a thin subclass adding only what the MVP actually needs on top of Cartesia:

```python
# apps/pipecat-bot/src/tts.py

from pipecat.services.cartesia.tts import CartesiaTTSService


class QuotidCartesiaTTSService(CartesiaTTSService):
    """
    MVP TTS. Subclassed (not wrapped) per decision #7 so the future
    `ModalTTSService` can slot in by swapping the pipeline constructor's
    `tts = ...` line — nothing else in the pipeline knows which
    implementation it is.

    The class exists (rather than using CartesiaTTSService directly) so we
    have a single place to add Quotid-specific concerns: custom error
    handling, latency metrics tagging, or voice-switching by user
    preference. Empty body is fine for MVP.
    """
    pass
```

**Why subclass rather than wrap:**
- Wrapping would require our class to implement the full `TTSService` interface and forward every method — fragile, high maintenance.
- Subclassing inherits the full interface, override only what changes.
- The pipeline constructor references our class name once; swapping to `ModalTTSService` is a one-line change at the call site.
- Both `QuotidCartesiaTTSService` and a future `ModalTTSService` extend `TTSService` (not each other) — they're siblings, not a deepening chain. Keeps the swap clean.

**`ModalTTSService` sketch (future, not implemented):**

```python
class ModalTTSService(TTSService):
    """
    FUTURE. Runs TTS on a Modal-hosted model (e.g., Orpheus TTS or a
    fine-tuned Cartesia-compatible model) for cost control.

    Implements the same async generator contract as other TTSService
    subclasses: accepts text frames, emits AudioRawFrame batches.
    """
    async def run_tts(self, text: str) -> AsyncIterator[AudioRawFrame]:
        ...
```

The swap requires:
1. Implement `ModalTTSService` (Modal function call + audio streaming).
2. Change one line in `bot.py`: `tts = ModalTTSService(...)`.
3. Nothing else — no Pipeline changes, no aggregator changes, no transport changes.

## 8. Interruption handling

Pipecat's built-in mechanism; we enable it via `PipelineParams(allow_interruptions=True)`. Flow:

1. User starts speaking while assistant TTS is playing.
2. `SileroVADAnalyzer` in the user aggregator detects speech.
3. `InterruptionFrame` propagates through the pipeline, upstream of TTS.
4. TTS stops synthesis, current audio buffer flushes (TwilioFrameSerializer sends a `clear` event on the WSS).
5. LLM cancels any in-progress generation (if mid-stream).
6. New user turn begins; STT processes the incoming audio.

**What we don't need to write:** any of this. It's built in. The only thing we configure is `allow_interruptions=True`.

**What can go wrong:** TTS tail gets truncated mid-word. Assistant aggregator still captures what was *emitted* (post-interruption), so the conversation history stays accurate. The LLM sees "I was going to say [truncated]..." on the next turn, which is fine.

## 9. Transcript accumulation

`TranscriptAccumulator` is a custom `FrameProcessor` that sits after the STT and before the user aggregator. It siphons final transcripts and speaker labels without modifying the pipeline's frame flow:

```python
# apps/pipecat-bot/src/transcript.py

from dataclasses import dataclass, field
from typing import List
from pipecat.frames.frames import (
    Frame, TranscriptionFrame, LLMFullResponseEndFrame, TextFrame,
)
from pipecat.processors.frame_processor import FrameProcessor


@dataclass
class TranscriptSegment:
    speaker: str            # "user" or "assistant"
    text: str
    start_ms: int
    end_ms: int
    confidence: float | None


class TranscriptAccumulator(FrameProcessor):
    """
    Passive observer. Records final USER transcripts with audio-level
    timestamps into `_segments`. Assistant-side capture is handled
    differently — see `build_outcome` below.
    """
    def __init__(self, context: LLMContext) -> None:
        super().__init__()
        self._segments: list[TranscriptSegment] = []
        self._started_at: float | None = None
        self._context = context    # hold reference for assistant-side read

    async def process_frame(self, frame: Frame, direction) -> None:
        # Siphon, don't filter — pass everything downstream unchanged.
        if isinstance(frame, TranscriptionFrame) and frame.is_final:
            self._segments.append(TranscriptSegment(
                speaker="user",
                text=frame.text,
                start_ms=frame.start_ms,
                end_ms=frame.end_ms,
                confidence=frame.confidence,
            ))
        await self.push_frame(frame, direction)

    async def build_outcome(
        self,
        *,
        call_session_id: str,
        call_sid: str,
        twilio_client,
    ) -> "CallOutcome":
        """
        Merge: user segments from `self._segments` (with audio timestamps)
        PLUS assistant turns read from `self._context.messages` (role ==
        "assistant"; no audio-level timestamps, ordering preserved).

        Also fetches `recording_url` from Twilio:
            recordings = await twilio_client.recordings.list_async(
                call_sid=call_sid, limit=1,
            )
            recording_url = recordings[0].uri if recordings else None
        Sets `CallOutcome.recording_url` so `store_entry` can persist it
        to `CallSession.recording_url` for `canonicalize_transcript`
        (transcription-interface.md §5.3) to consume.

        Async because Twilio's recording lookup is a network call. The
        merged transcript itself is good enough for `summarize` (the
        Sonnet post-call summary needs content + speaker order, not
        precise milliseconds). Step 6's canonical transcript will
        re-derive timing from the recorded audio if needed.
        """
        ...
```

**Why this split:** capturing assistant text from the frame stream would require a second FrameProcessor wired into the pipeline after `transport.output()`. Reading from `LLMContext.messages` at pipeline end is simpler (zero extra pipeline components) and accepts a small information loss — the LLM context already has the authoritative assistant-turn text; we give up only audio-level timestamps for the assistant side, which the MVP summary doesn't use.

## 10. System prompt / conversation strategy

**Out of scope for this design doc** — belongs in `apps/pipecat-bot/src/prompts.py` when scaffolded. One sentence of shape so there's no ambiguity: the system prompt instructs the LLM to conduct a **Storyworthy-style** journaling conversation (handoff §Who/What/When), keeping turns short (~1 sentence per assistant turn) and ending the conversation with a graceful wrap-up when the user signals done.

## 11. Latency budget

Target from decision #12: **1.0–1.5 s voice-to-voice** (end of user turn to first synthesized audio reaching the user).

| Stage | Typical | Worst case | Notes |
|---|---|---|---|
| PSTN → Twilio edge → our VM (RTT one-way) | 50 ms | 150 ms | Depends on carrier; mostly unchangeable |
| Silero VAD inference (**estimated**) | 30 ms | 80 ms | Per-frame; effectively amortized. Not measured on Oracle A1 — verify during impl. |
| VAD `stop_secs=0.2` window | 200 ms | 200 ms | Fixed configured delay |
| SmartTurn inference (**estimated**) | 100 ms | 200 ms | Local ONNX classifier on CPU. Pipecat docs claim "fast CPU inference" without a specific number; estimate based on typical small classifier sizes. Measure during impl. |
| Deepgram streaming final transcript | 150 ms | 400 ms | After audio end |
| **LLM (Haiku) first-token latency** | 300 ms | 700 ms | OpenRouter → Anthropic route |
| Cartesia first-audio-chunk | 100 ms | 250 ms | Streaming start |
| Our VM → Twilio → PSTN (one-way) | 50 ms | 150 ms | |
| **Total voice-to-voice** | **~980 ms** | **~2130 ms** | Typical hits target; worst-case overshoots |

**Where we can cut if tail latency is bad:**
- Prompt caching (decision #8 mentions it works through OpenRouter) — caches the system prompt on Anthropic's side, saving ~100 ms on each turn after the first.
- Shorter `stop_secs` on VAD (down to 0.1 s) — aggressive, may increase false turn-ends.
- Move TTS to Modal with a warmed model instance (future — decision #7's payoff).

## 12. Error handling

| Failure | Detection | Response |
|---|---|---|
| Deepgram WSS drops | Pipeline error frame | Pipecat retries connection up to 3×; on permanent failure, pipeline ends with error, Temporal activity completed with `CallOutcome(status=FAILED, failure_reason="stt_unavailable")`. |
| OpenRouter 5xx | Exception in `OpenAILLMService` | Pipecat surfaces as `ErrorFrame`; pipeline ends. Same FAILED outcome. |
| Cartesia WSS drops | Pipeline error frame | Pipecat auto-reconnects TTS; if it can't, pipeline ends. Same FAILED outcome. |
| Twilio WSS close (user hangup) | Normal pipeline end | `CallOutcome(status=COMPLETED, ...)` with transcript. |
| Bot hangs (SmartTurn loop, etc.) | Temporal `await_call` 20-min `start_to_close_timeout` | Workflow degrades to FAILED branch (temporal-workflow.md §3.2 backstop). |
| Pipecat server crash | Twilio `statusCallback` → Next.js webhook → watchdog (temporal-workflow.md §5) | Webhook async-completes the activity with FAILED. |

## 13. Open questions (defer until implementation)

1. **Cartesia voice selection.** One voice across all users MVP; configurable per-user in a later iteration. Env var `CARTESIA_VOICE_ID` for now.
2. **System prompt content.** Storyworthy-style journaling conversation is the direction; actual wording is a prompt-engineering task post-scaffold.
3. **Conversation-end detection.** How does the bot decide it's done? Options: (a) LLM returns a specific tool/function call indicating "wrap up", (b) fixed duration (e.g., end after 10 min), (c) user-signalled ("I'm done"). MVP probably uses (c) + (b) as hard cap. Needs user input during implementation.
4. **Barge-in during bot opening line.** Should the user be able to interrupt the bot's greeting? `allow_interruptions=True` says yes by default; may want to disable for the first ~3 seconds so the greeting actually completes.
5. **SmartTurn model-instance sharing across concurrent pipelines.** §4 instantiates `LocalSmartTurnAnalyzerV3()` inside `run_bot` — one per call. The ONNX Runtime generally mmaps weights from a shared model file, so 4 concurrent calls shouldn't mean 4× RAM for weights; but inference sessions are per-instance and may have state. Worth a memory-and-latency measurement at implementation time. If bad, try instantiating once at module scope and sharing IFF the analyzer turns out to be stateless across conversations (verify with Pipecat maintainers if unclear).

---

**Step 5 status:** design locked. Ready for Step 6 (Modal transcription provider interface) or implementation scaffolding.
