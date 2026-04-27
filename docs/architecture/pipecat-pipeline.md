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
| `pipecat.services.stt_service` | `STTService` | Abstract STT base — returned by `stt_factory.make_stt()` (§7.5). |
| `pipecat.services.deepgram.stt` | `DeepgramSTTService` | Streaming STT (Nova-3-general — see §7.5). |
| `pipecat.services.openai.llm` | `OpenAILLMService` | LLM — pointed at OpenRouter via custom `base_url`. |
| `pipecat.services.deepgram.tts` | `DeepgramTTSService` | Streaming TTS (Aura). |
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

Four distinct endpoints handle the call lifecycle:
1. **`POST /calls`** — creates the Twilio call, returns quickly with `call_sid`. No pipeline built yet. Now passes `machine_detection="Enable"` so Twilio surfaces an `AnsweredBy` form param to `/twiml` (§2.2).
2. **`GET/POST /calls/{call_session_id}/twiml`** — branches on `AnsweredBy` (§2.2): `<Connect><Stream/></Connect>` for human/unknown, `<Hangup/>` for `machine_*`/`fax`.
3. **`WSS /calls/{call_sid}/stream`** — Twilio initiates this after its `twiml_url` callback. This is where the pipeline lives.
4. **Live-call surfaces** (§2.3) — `GET /calls/{sid}/transcript` and `POST /calls/{sid}/end`, used by the live-call dashboard. Internal-only (Caddy 403s public access).

They share state via two parallel in-process registries (`quotid_bot/correlation.py`), both keyed by `call_sid`:
- `_REGISTRY: dict[str, CallCorrelation]` — `{workflow_id, activity_id, call_session_id, voice, user_name}`. Set by `POST /calls`, read by the WSS handler to complete the Temporal activity, and by `POST /calls/{sid}/end` to short-circuit it on user hangup.
- `_COLLECTORS: dict[str, TranscriptCollector]` — installed by the WSS handler at `register_collector()` time so `GET /calls/{sid}/transcript` can read the in-flight segment list.

`remove(call_sid)` clears both. This is ephemeral memory — if the Bot Server restarts, in-flight calls are lost, the Temporal watchdog (`/api/webhooks/twilio/call-status`) handles that case.

**Single-worker requirement:** these registries live in one Python process's memory. The Bot Server MUST run with `uvicorn --workers=1` (or gunicorn equivalent). Multi-worker setups would route the `POST /calls`, the WSS, and the live-transcript GET to different workers, each with an empty registry. If horizontal scaling becomes necessary, move the registries to Redis keyed by `call_sid` with a 1-hour TTL — but MVP concurrency cap is 4 calls, well within one worker's capacity.

### 2.2 AMD branching (`/twiml`)

`twilio.calls.create(...)` is invoked with `machine_detection="Enable"`. Twilio waits ~3 s after pickup, classifies the answerer, then includes an `AnsweredBy` form param when it requests TwiML. The `/twiml` handler forks on it:

| `AnsweredBy` | TwiML returned | Effect |
|---|---|---|
| `human`, `unknown`, or unset | `<Response><Connect><Stream url=".../stream"/></Connect></Response>` | WSS opens; pipeline runs as normal. |
| `machine_*` (e.g. `machine_end_beep`) or `fax` | `<Response><Hangup/></Response>` | Twilio hangs up. The subsequent `completed` status callback (with `AnsweredBy=machine_*`) is the signal the webhook uses to drive the workflow to `NO_ANSWER` — see `temporal-workflow.md` §5. |

Cost: ~$0.0075/call for AMD. Net: prevents the bot from monologuing into voicemail and burning summary tokens on a non-conversation.

### 2.3 Live-call endpoints

Two read/write surfaces over the in-flight call. Both are internal-only — Caddy 403s public POSTs to `/calls`, and the live-transcript / end endpoints sit alongside it under the same prefix. The Next.js web app reaches them via `BOT_INTERNAL_URL`.

**`GET /calls/{call_sid}/transcript`** → `{segments: [{speaker, text}, ...]}`

Reads `_COLLECTORS[call_sid]` from the correlation module and returns whatever segments the `UserTranscriptCapture` / `AssistantTextCapture` frame processors have appended so far (§9). If no collector is registered (pipeline not yet started, or already finalized and removed), returns `{segments: []}` — caller falls back to the persisted REALTIME row in the DB. The dashboard polls this endpoint while the call is live.

This surface is **transient and in-memory only** — distinct from the persisted `Transcript` row that `store_entry` writes after the call ends. It exposes the same `TranscriptCollector.segments` list but at frame-flow latency, not workflow completion latency.

**`POST /calls/{call_sid}/end`** → `{ok: true}`

User-initiated hang-up. Two-step compound action:

1. `twilio.calls(call_sid).update(status="completed")` — tells Twilio to tear down the call leg. Twilio will then emit its `completed` status callback in the normal way.
2. `fail_await_call(corr.workflow_id, "user_ended")` — directly drives the Temporal `await-call` activity to FAILED. Necessary because the WSS may never have opened (e.g. AMD-detected voicemail that the user manually ended before TwiML was even fetched), in which case nobody else would complete the activity and the workflow would block until its 20-minute backstop fires. If the WSS *did* open and is mid-pipeline, the Twilio close also triggers `on_client_disconnected` → `task.cancel()` → normal outcome flow; one of the two completions wins, the other is a swallowed already-completed.

Twilio rejections surface via `TwilioRestException`; the handler forwards Twilio's HTTP status (4xx/5xx) to the caller via `HTTPException(status_code=…)` so the proxying Next.js layer can render meaningfully. `POST /calls` uses the same forwarding pattern so the worker's `initiate_call` activity can classify retryability — 4xx → non-retryable `TwilioClientError` ApplicationError, 5xx → retryable.

## 3. Pipeline graph

```
┌─────────────────────────────────────────────────────────────────┐
│ FastAPIWebsocketTransport (input)                               │
│   · reads Twilio Media Streams frames                           │
│   · decodes via TwilioFrameSerializer (μ-law 8kHz → PCM)        │
└───────────────┬─────────────────────────────────────────────────┘
                │ AudioRawFrame
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ stt (STTService — currently DeepgramSTTService nova-3-general)  │
│   · constructed by stt_factory.make_stt() (§7.5)                │
│   · streams audio over WSS to the chosen provider               │
│   · emits TranscriptionFrame (interim + final) per turn         │
└───────────────┬─────────────────────────────────────────────────┘
                │ TranscriptionFrame
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ UserTranscriptCapture (custom FrameProcessor, §9)               │
│   · siphons final TranscriptionFrames into the shared collector │
│   · passes every frame through unchanged                        │
└───────────────┬─────────────────────────────────────────────────┘
                │ TranscriptionFrame (unchanged)
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
│   · streams tokens → emits LLMTextFrame + LLMFullResponse{Start,│
│                                                          End}   │
└───────────────┬─────────────────────────────────────────────────┘
                │ LLMTextFrame (streaming)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ AssistantTextCapture (custom FrameProcessor, §9)                │
│   · buffers LLMTextFrames between Start/End markers             │
│   · appends one assistant Segment per LLM response              │
│   · passes every frame through unchanged                        │
└───────────────┬─────────────────────────────────────────────────┘
                │ LLMTextFrame (unchanged)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ DeepgramTTSService (QuotidDeepgramTTSService subclass)          │
│   · per-call voice from build_pipeline(voice=...) arg           │
│   · streams incoming text → synthesized PCM audio (Aura)        │
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

**Why two custom FrameProcessors instead of a single post-hoc reader of `LLMContext.messages`:** the prior design read assistant turns from the LLM context at pipeline end and merged them with user segments captured during the call. That works for content but not for **chronological order**: user transcripts are finalized by STT after a delay, while assistant messages are written into the context before TTS even starts speaking. Reading `LLMContext.messages` post-hoc gives roughly-correct turns but cannot reliably interleave them with the user side. Capturing both sides at frame-flow time — `UserTranscriptCapture` immediately after STT, `AssistantTextCapture` immediately after the LLM — appends to a single shared `TranscriptCollector.segments` list in the order frames actually arrive, which IS chronological by construction.

**Why `assistant_aggregator` is AFTER `transport.output()`**: the assistant aggregator needs to know what was *actually sent to the user*, including any interruption-induced truncations. Placing it after output captures the final emitted text, not the pre-interruption LLM output. This is the canonical Pipecat pattern. Note this is independent from the assistant-side transcript capture in §9 — `AssistantTextCapture` records what the LLM produced for the journal transcript; the `assistant_aggregator` records what reached the user for the LLM's own conversation history. The two sources can drift on interruption; we accept that for MVP.

## 4. Pipeline assembly (Python pseudocode)

```python
# apps/pipecat-bot/quotid_bot/pipeline.py — current shape, abridged.

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair, LLMUserAggregatorParams,
)
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams, FastAPIWebsocketTransport,
)
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .config import CONFIG
from .stt_factory import make_stt
from .system_prompt import opening_line, system_prompt
from .transcript_accumulator import (
    AssistantTextCapture, TranscriptCollector, UserTranscriptCapture,
)


class QuotidDeepgramTTSService(DeepgramTTSService):
    """Empty subclass — swap point for future ModalTTSService (decision #7)."""


DEFAULT_VOICE = "aura-2-thalia-en"


def build_pipeline(
    websocket,
    stream_sid: str,
    call_sid: str,
    *,
    voice: str | None = None,
    user_name: str | None = None,
) -> tuple[PipelineTask, TranscriptCollector, LLMContext]:
    """
    Construct the per-call pipeline. Caller-name and voice are threaded in
    from `CallCorrelation`, which the worker populated via the user's row
    (`User.name`, `User.voicePreference`). `voice` falls back to
    `DEFAULT_VOICE`; `user_name=None` is acceptable — the system prompt
    template substitutes "the caller".
    """
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

    # STT chosen by env (§7.5). Returns (service, label) — the label is
    # threaded into the collector so the persisted Transcript.provider
    # column reflects whichever vendor actually transcribed the call.
    stt, stt_provider_label = make_stt()

    llm = OpenAILLMService(
        api_key=CONFIG.openrouter_api_key,
        base_url="https://openrouter.ai/api/v1",
        model="anthropic/claude-haiku-4-5",
    )

    tts = QuotidDeepgramTTSService(            # see §7
        api_key=CONFIG.tts_api_key,            # env-split from STT key (§7.5)
        voice=voice or DEFAULT_VOICE,          # per-call, with bot-side fallback
    )

    # ── Context + transcript collector + capture processors ─────────────
    context = LLMContext(
        messages=[{"role": "system", "content": system_prompt(user_name)}]
    )
    greeting = opening_line(user_name)
    collector = TranscriptCollector(
        opening_line=greeting,                  # seeds segment 0
        provider=stt_provider_label,            # carried into CallOutcome
    )
    user_capture = UserTranscriptCapture(collector)
    asst_capture = AssistantTextCapture(collector)

    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(
                stop_secs=0.2, start_secs=0.2, confidence=0.7,
            )),
            user_turn_strategies=UserTurnStrategies(
                stop=[TurnAnalyzerUserTurnStopStrategy(
                    turn_analyzer=LocalSmartTurnAnalyzerV3(),
                )],
            ),
        ),
    )

    # ── Pipeline ────────────────────────────────────────────────────────
    pipeline = Pipeline([
        transport.input(),
        stt,
        user_capture,                # §9 — captures final user transcripts
        user_aggregator,
        llm,
        asst_capture,                # §9 — captures assistant responses pre-TTS
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
        # Queue the opening line as a TextFrame so TTS speaks it first.
        # The collector was already seeded with the same line at construction,
        # so the transcript starts with assistant turn 0 even though the LLM
        # wasn't invoked to produce it.
        await task.queue_frames([TextFrame(greeting)])

    # CRITICAL: register disconnect handler. Without this, runner.run() hangs
    # indefinitely after the WSS closes because the PipelineTask never
    # receives a cancellation signal.
    @transport.event_handler("on_client_disconnected")
    async def on_disconnect(_t, _client):
        await task.cancel()

    return task, collector, context
```

The WSS handler in `quotid_bot/server.py` runs the task with `PipelineRunner(handle_sigint=False)`, then on normal end calls `collector.build_outcome(call_session_id, twilio_call_sid, twilio_client)` to produce the `CallOutcome` payload and async-completes the Temporal `await-call` activity. The completion helper tolerates the already-completed case (Twilio status webhook got there first) by swallowing the not-found error — matches the race-safe design in `docs/architecture/temporal-workflow.md` §5.

## 5. Audio format & transport config

Per decision #11:

| Leg | Format | Sample rate | Handled by |
|---|---|---|---|
| Twilio ↔ Pipecat WSS | μ-law encoded | 8 kHz | `TwilioFrameSerializer` (transparent) |
| Pipeline internal | Linear PCM (16-bit signed) | 8 kHz | Pipecat default once serializer decodes |
| Deepgram streaming input | Linear PCM | 8 kHz (passed through) | Deepgram handles upsampling internally if needed |
| Deepgram TTS streaming output | Linear PCM | 8 kHz (we request) | Set via `DeepgramTTSService.Settings` if needed to match |

`PipelineParams(audio_in_sample_rate=8000, audio_out_sample_rate=8000)` tells Pipecat the wire format expected by the transport. The STT and TTS services adapt to the pipeline's PCM stream; they don't know or care about Twilio.

**What we give up by staying at 8 kHz:** a bit of TTS fidelity — Deepgram Aura sounds better at higher sample rates. But telephony codecs downsample anyway; any extra bandwidth is discarded before the user hears it. 8 kHz end-to-end avoids one resampling step and ~10–20 ms of CPU-bound latency.

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
└── pipecat.services.deepgram.tts.DeepgramTTSService   (Pipecat built-in)
    └── apps.pipecat-bot.src.tts.QuotidDeepgramTTSService   (our MVP subclass)

pipecat.services.tts.TTSService
└── apps.pipecat-bot.src.tts.ModalTTSService   (FUTURE — swap target)
```

`QuotidDeepgramTTSService` is a thin subclass adding only what the MVP actually needs on top of Deepgram:

```python
# apps/pipecat-bot/src/tts.py

from pipecat.services.deepgram.tts import DeepgramTTSService


class QuotidDeepgramTTSService(DeepgramTTSService):
    """
    MVP TTS. Subclassed (not wrapped) per decision #7 so the future
    `ModalTTSService` can slot in by swapping the pipeline constructor's
    `tts = ...` line — nothing else in the pipeline knows which
    implementation it is.

    The class exists (rather than using DeepgramTTSService directly) so we
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
- Both `QuotidDeepgramTTSService` and a future `ModalTTSService` extend `TTSService` (not each other) — they're siblings, not a deepening chain. Keeps the swap clean.

**`ModalTTSService` sketch (future, not implemented):**

```python
class ModalTTSService(TTSService):
    """
    FUTURE. Runs TTS on a Modal-hosted model (e.g., Orpheus TTS) for cost control.

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

## 7.5 STT factory — single decision point

Symmetric to the TTS subclass swap point (§7), STT selection is centralized in `quotid_bot/stt_factory.py`. The factory returns a `(STTService, label)` tuple; the pipeline assembly destructures it and threads the label into `TranscriptCollector` (§9) so the persisted `Transcript.provider` column reflects whichever provider actually ran.

```python
# apps/pipecat-bot/quotid_bot/stt_factory.py

from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.stt_service import STTService

from .config import CONFIG


def make_stt() -> tuple[STTService, str]:
    """Return (service, provider_label).

    The label is a value of Prisma's TranscriptProvider enum
    (DEEPGRAM | WHISPERX | OTHER). Adding a new label requires a
    Prisma migration as well as a new branch here.
    """
    provider = CONFIG.stt_provider.lower()
    match provider:
        case "deepgram":
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
```

**Why explicit endpointing settings rather than Pipecat defaults:** the streaming-side end-of-turn behavior interacts with `LocalSmartTurnAnalyzerV3` (§6). Pinning `endpointing=300` (Deepgram emits a final result 300 ms after the last word) and `utterance_end_ms=1000` (force a `UtteranceEnd` event after a 1-second silent gap even if endpointing didn't fire) makes the upgrade path to a different STT vendor reproducible — a future `case "assemblyai"` arm can map its own knobs to equivalents instead of inheriting a different vendor's defaults.

**Why Nova-3-general specifically:** it's Deepgram's flagship streaming model — roughly half the WER of Nova-2 (the prior default) on noisy phone-line audio. Drop-in upgrade; no API surface change.

**Env config (`quotid_bot/config.py`):**

| Var | Default | Purpose |
|---|---|---|
| `STT_PROVIDER` | `"deepgram"` | Selects the `make_stt()` branch. Lowercased before matching. |
| `STT_API_KEY` | falls back to `DEEPGRAM_API_KEY` | API key passed to whichever STT service is built. Fallback lets a single legacy `DEEPGRAM_API_KEY` keep working without env-file churn. |
| `TTS_PROVIDER` | `"deepgram"` | Reserved for a future symmetric `make_tts()` factory. Currently unread; the pipeline directly constructs `QuotidDeepgramTTSService`. |
| `TTS_API_KEY` | falls back to `DEEPGRAM_API_KEY` | API key consumed by the TTS service. Same fallback rationale. |

The fallback is one-way: setting `STT_API_KEY` overrides `DEEPGRAM_API_KEY`, but unsetting `STT_API_KEY` re-exposes the legacy key. The split exists so a future provider swap (e.g. AssemblyAI) can ship without revoking Deepgram credentials.

**Adding a new STT vendor** is a four-step change:
1. Add the Pipecat extra in `pyproject.toml` (e.g. `pipecat-ai[assemblyai]`).
2. Add a `case` branch here that builds the service and returns the matching label.
3. Add the label to Prisma's `TranscriptProvider` enum (migration).
4. Set `STT_PROVIDER=<provider>` in the bot's env.

The pipeline graph and frame processors don't change — both the realtime collector and the persisted `Transcript.provider` column are vendor-agnostic by construction.

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

The realtime transcript is built by **three cooperating objects** that share one mutable list. There is no post-hoc merge; segments are appended in chronological order as frames flow through the pipeline.

| Object | Role | Pipeline position |
|---|---|---|
| `TranscriptCollector` | Holds the segment list; seeded with the opening line at construction; produces the `CallOutcome` at pipeline end | n/a (held by reference, not in the pipeline) |
| `UserTranscriptCapture` | Appends one `Segment("user", text)` per **final** `TranscriptionFrame` | After `stt`, before `user_aggregator` |
| `AssistantTextCapture` | Buffers `LLMTextFrame`s between `LLMFullResponseStartFrame` / `LLMFullResponseEndFrame` and appends one `Segment("assistant", joined_text)` per LLM response | After `llm`, before `tts` |

```python
# apps/pipecat-bot/quotid_bot/transcript_accumulator.py

from dataclasses import dataclass

from pipecat.frames.frames import (
    Frame, LLMFullResponseEndFrame, LLMFullResponseStartFrame,
    LLMTextFrame, TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass
class Segment:
    speaker: str   # "user" | "assistant"
    text: str


class TranscriptCollector:
    """Single source of truth for the call's chronological transcript.

    User and assistant frame processors append to the same `segments`
    list as final-form text becomes available, so the order is naturally
    chronological — no post-hoc reassembly from LLM context.
    """

    def __init__(
        self,
        *,
        opening_line: str | None = None,
        provider: str = "DEEPGRAM",
    ) -> None:
        self.segments: list[Segment] = []
        # Provider label is a value of Prisma's TranscriptProvider enum.
        # Seeded by `make_stt()` (§7.5) so swapping STT vendors does not
        # require touching this class — the label flows into the outcome
        # dict and ultimately into Transcript.provider.
        self._provider = provider
        if opening_line and opening_line.strip():
            # Seed with the bot's greeting. The greeting is queued as a
            # TextFrame to TTS but never goes through the LLM, so the
            # AssistantTextCapture would otherwise miss it.
            self.segments.append(Segment("assistant", opening_line.strip()))

    async def build_outcome(
        self,
        *,
        call_session_id: str,
        twilio_call_sid: str,
        twilio_client,
    ) -> dict:
        """Materialize CallOutcome at pipeline end.

        Looks up Twilio for: recording URL (recordings.list), call
        timestamps (calls.fetch — start_time, end_time, duration). Both
        are wrapped in try/except — Twilio failures don't block outcome
        delivery; the workflow degrades to "no recording, no precise
        timing" rather than failing the whole call.

        Returns a dict matching CallOutcome's wire shape — Pydantic on
        the worker side parses it back into a CallOutcome model.

        Includes `transcript_provider=self._provider`, which the worker's
        `store_entry` activity reads when writing the Transcript row's
        `provider` column. The worker no longer hardcodes "DEEPGRAM";
        the bot is the source of truth.
        """
        ...


class UserTranscriptCapture(FrameProcessor):
    """Sits after STT and before the user aggregator. Records each final
    user transcription as it lands."""

    def __init__(self, collector: TranscriptCollector) -> None:
        super().__init__()
        self._collector = collector

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            is_final = getattr(frame, "is_final", True)
            text = (frame.text or "").strip()
            if is_final and text:
                self._collector.segments.append(Segment("user", text))
        await self.push_frame(frame, direction)


class AssistantTextCapture(FrameProcessor):
    """Sits after the LLM and before TTS. Buffers streamed LLMTextFrames
    between LLMFullResponseStartFrame and LLMFullResponseEndFrame, then
    appends the joined text as a single assistant segment."""

    def __init__(self, collector: TranscriptCollector) -> None:
        super().__init__()
        self._collector = collector
        self._buffer = ""
        self._in_response = False

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self._buffer = ""
            self._in_response = True
        elif isinstance(frame, LLMFullResponseEndFrame):
            text = self._buffer.strip()
            if text:
                self._collector.segments.append(Segment("assistant", text))
            self._buffer = ""
            self._in_response = False
        elif isinstance(frame, LLMTextFrame) and self._in_response:
            self._buffer += frame.text or ""
        await self.push_frame(frame, direction)
```

**Segment shape is now `{speaker, text}` only.** The earlier design carried `start_ms`, `end_ms`, and `confidence` on each segment, copied off `TranscriptionFrame` fields. Two reasons we dropped that:

1. **The summary prompt doesn't use timing.** Sonnet only needs content + speaker order; millisecond precision adds noise without changing output.
2. **There was no symmetric source for assistant timing.** The LLM emits `LLMTextFrame`s as tokens stream; "when did the assistant say this" isn't a single millisecond — it's a span that depends on TTS pacing, which isn't observable from the LLM frame. Carrying timestamps on user segments and not on assistant segments would lie about parity. If we ever need real per-word timing, that's the canonical-transcript path (`transcription-interface.md`), which re-derives timing from the recorded audio.

**Why capture both sides at frame-flow time instead of reading `LLMContext.messages` at pipeline end:** the prior design captured user transcripts via a single `TranscriptAccumulator` between STT and the user aggregator, then pulled assistant turns from the LLM context post-hoc. That doesn't preserve interleaving: STT finalizes user turns after a delay (`stop_secs` + SmartTurn), while assistant text is in the context the moment the LLM finishes streaming. The two timelines diverge enough that "user said X, then assistant said Y" gets reordered. Two FrameProcessors writing to one shared list, in their natural pipeline positions, encodes chronology by construction.

**`build_outcome` also fetches Twilio metadata.** Beyond the segments, it calls `twilio_client.recordings.list(call_sid=..., limit=1)` for the recording URL (consumed later by `canonicalize_transcript`, see `transcription-interface.md` §5.3) and `twilio_client.calls(sid).fetch()` for `start_time` / `end_time` / `duration`. Both are wrapped in `try/except` — Twilio outages cannot block the activity completion; the workflow tolerates `recording_url=None` and missing timestamps. The returned dict carries `transcript_provider` (seeded from the constructor) alongside `transcript_text`, `transcript_segments`, `recording_url`, `started_at`, `ended_at`, and `duration_seconds`.

## 10. System prompt / conversation strategy

Lives in `apps/pipecat-bot/quotid_bot/system_prompt.py`. The module exposes two functions:

```python
def opening_line(name: str | None) -> str: ...
def system_prompt(name: str | None) -> str: ...
```

Both accept an optional caller name. `name=None` substitutes "the caller" in the prompt and "Hey" (no name) in the greeting — that lets the bot work for users whose `User.name` row is null. The worker reads `User.name` in `create_call_session` and threads it through `CreateCallSessionResult.user_name` → `InitiateCallInput.user_name` → the bot's `POST /calls` payload → `CallCorrelation.user_name` → `build_pipeline(user_name=...)`.

**The prompt explicitly forbids markdown.** Output is spoken aloud by Deepgram Aura, which reads `*got*` as "asterisk got asterisk" — asterisks, underscores, backticks, hashes, and hyphen-bullets all leak into the audio. The prompt instructs the LLM to "stress a word with phrasing, not punctuation." If we ever add a tool/function-calling path that produces structured output, that path needs to bypass TTS; markdown-in-TTS is unfixable downstream of the LLM.

The conversation strategy itself is **Storyworthy-style** journaling: surface one concrete moment from the day plus a short follow-up about how it felt. Friend-on-the-phone register, one question at a time, no listing, match the user's energy. Wrap up on explicit user-side end signals ("that's all", "I'm done", "goodbye").

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
| Deepgram TTS first-audio-chunk | 100 ms | 250 ms | Streaming start |
| Our VM → Twilio → PSTN (one-way) | 50 ms | 150 ms | |
| **Total voice-to-voice** | **~980 ms** | **~2130 ms** | Typical hits target; worst-case overshoots |

**Where we can cut if tail latency is bad:**
- Prompt caching (decision #8 mentions it works through OpenRouter) — caches the system prompt on Anthropic's side, saving ~100 ms on each turn after the first.
- Shorter `stop_secs` on VAD (down to 0.1 s) — aggressive, may increase false turn-ends.
- Move TTS to Modal with a warmed model instance (future — decision #7's payoff; would replace Deepgram with a self-hosted model).

## 12. Error handling

| Failure | Detection | Response |
|---|---|---|
| Deepgram WSS drops | Pipeline error frame | Pipecat retries connection up to 3×; on permanent failure, pipeline ends with error, Temporal activity completed with `CallOutcome(status=FAILED, failure_reason="stt_unavailable")`. |
| OpenRouter 5xx | Exception in `OpenAILLMService` | Pipecat surfaces as `ErrorFrame`; pipeline ends. Same FAILED outcome. |
| Deepgram TTS WSS drops | Pipeline error frame | Pipecat auto-reconnects TTS; if it can't, pipeline ends. Same FAILED outcome. |
| Twilio WSS close (user hangup) | Normal pipeline end | `CallOutcome(status=COMPLETED, ...)` with transcript. |
| Bot hangs (SmartTurn loop, etc.) | Temporal `await_call` 20-min `start_to_close_timeout` | Workflow degrades to FAILED branch (temporal-workflow.md §3.2 backstop). |
| Pipecat server crash | Twilio `statusCallback` → Next.js webhook → watchdog (temporal-workflow.md §5) | Webhook async-completes the activity with FAILED. |

## 13. Open questions (defer until implementation)

1. **Deepgram voice selection.** Per-user, sourced from `User.voicePreference` (`prisma/schema.prisma`, default `aura-2-thalia-en`). The worker reads it in `create_call_session` and passes it through `InitiateCallInput.voice` → bot `POST /calls` → `build_pipeline(voice=...)`. The bot's `DEFAULT_VOICE = "aura-2-thalia-en"` is only a defensive fallback if `voice=None` somehow reaches the pipeline; the DB default makes that unreachable in practice.
2. **System prompt content.** Storyworthy-style journaling conversation is the direction; actual wording is a prompt-engineering task post-scaffold.
3. **Conversation-end detection.** How does the bot decide it's done? Options: (a) LLM returns a specific tool/function call indicating "wrap up", (b) fixed duration (e.g., end after 10 min), (c) user-signalled ("I'm done"). MVP probably uses (c) + (b) as hard cap. Needs user input during implementation.
4. **Barge-in during bot opening line.** Should the user be able to interrupt the bot's greeting? `allow_interruptions=True` says yes by default; may want to disable for the first ~3 seconds so the greeting actually completes.
5. **SmartTurn model-instance sharing across concurrent pipelines.** §4 instantiates `LocalSmartTurnAnalyzerV3()` inside `run_bot` — one per call. The ONNX Runtime generally mmaps weights from a shared model file, so 4 concurrent calls shouldn't mean 4× RAM for weights; but inference sessions are per-instance and may have state. Worth a memory-and-latency measurement at implementation time. If bad, try instantiating once at module scope and sharing IFF the analyzer turns out to be stateless across conversations (verify with Pipecat maintainers if unclear).

---

**Step 5 status:** design locked. Ready for Step 6 (Modal transcription provider interface) or implementation scaffolding.
