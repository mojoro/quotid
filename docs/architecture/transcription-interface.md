# Transcription Provider Interface — Quotid

**Scope:** Step 6 of the design phase. Defines the `TranscriptProvider` interface used to populate the `CANONICAL` transcript row for a `CallSession`, the MVP Deepgram-batch adapter, the future Modal + WhisperX adapter, the new Temporal activity (`canonicalize_transcript`), where it slots into `JournalingWorkflow`, and the fallback policy when canonical transcription fails.

**Deliverable:** design doc + Python pseudocode. **No implementation.**

**Authoritative sources consumed:**
- `docs/SESSION_HANDOFF.md` — decision #15 (CANONICAL as a second transcript row), decision #16 (Twilio-hosted recording URLs for MVP)
- `prisma/schema.prisma` — `Transcript`, `TranscriptKind`, `TranscriptProvider`, unique `(call_session_id, kind)`
- `docs/architecture/temporal-workflow.md` — §3 (activity catalogue), §7 (idempotency), §8 (timeouts)
- `docs/architecture/pipecat-pipeline.md` — §9 (`TranscriptCollector` + `UserTranscriptCapture` + `AssistantTextCapture` — MVP realtime transcript producer)
- `docs/architecture/api/pipecat-bot.openapi.yaml` — WSS contract

---

## 1. Overview

The MVP populates exactly one transcript row per `CallSession`, written by `store_entry` from the Pipecat `CallOutcome` payload:

| Row | `kind` | `provider` | Source |
|---|---|---|---|
| 1 | `REALTIME` | seeded by `stt_factory.make_stt()` (`pipecat-pipeline.md` §7.5) — currently `DEEPGRAM` (Nova-3-general) | Streaming STT, captured by the bot's `UserTranscriptCapture` + `AssistantTextCapture` frame processors writing into a shared `TranscriptCollector` during the call. The collector is constructed with `provider=stt_provider_label`; that label flows through `CallOutcome.transcript_provider` into the `Transcript.provider` column via `store_entry` — no longer hardcoded. Segments are `{speaker, text}` only (no timing) — see `pipecat-pipeline.md` §9. |

Step 6 adds a **second, optional row** produced after the call ends:

| Row | `kind` | `provider` | Source |
|---|---|---|---|
| 2 | `CANONICAL` | `DEEPGRAM` (MVP) → `WHISPERX` (future) | Batch transcription of the Twilio-hosted recording, run post-call |

**Live-transcript polling is a distinct surface.** While a call is in progress, `GET /calls/{call_sid}/transcript` on the bot returns whatever segments the `TranscriptCollector` has accumulated so far (`pipecat-pipeline.md` §2.3). That endpoint is **transient and in-memory only** — it reads `_COLLECTORS[call_sid]` on the bot's in-process registry, returns `{segments: []}` once the call finalizes and the collector is removed, and is never persisted by itself. The persisted `Transcript` row written by `store_entry` after the call ends is the durable artifact; the polling endpoint exists purely to drive the live-call dashboard. The two surfaces share a producer (the same `TranscriptCollector.segments` list) but have different lifetimes and access patterns.

### 1.1 What "canonical" buys us

The realtime transcript is optimized for **latency**: Deepgram streams partial results so the LLM can respond within the 1.0–1.5 s budget (`pipecat-pipeline.md` §11). It sacrifices some accuracy in exchange. Realtime output has:

- No access to future context when deciding a word boundary.
- Limited punctuation and capitalization refinement.
- No per-segment timing — only `{speaker, text}` per turn.
- Speaker labels assigned from frame-flow position (`UserTranscriptCapture` after STT; `AssistantTextCapture` after LLM), not from acoustic diarization. Reliable for two-party calls but doesn't generalize.

A **canonical** transcript reprocesses the recorded audio end-to-end with the whole clip available as context. On the same Deepgram account, the batch API applies:

- A more aggressive model tier (`nova-3-general` with `paragraphs=true`, `diarize=true`, `utterances=true`).
- Full-audio punctuation and speaker attribution.
- Word-level timestamps that are stable across re-runs.

When Modal + WhisperX ships, canonical upgrades further: WhisperX adds forced-alignment timestamps (per-phoneme, not per-word) and higher-accuracy transcription on accented / noisy audio that telephony-codec Deepgram streaming tends to degrade on.

### 1.2 Design seam

One Python `Protocol` — `TranscriptProvider` — with two implementations:
1. `DeepgramBatchTranscriptProvider` — **MVP**, zero new infrastructure.
2. `ModalWhisperXProvider` — **future**, activated by swapping one line in the worker bootstrap.

The seam mirrors the TTS seam in `pipecat-pipeline.md` §7 — sibling implementations under a common abstraction, selected at construction time. The pipeline / workflow never sees which implementation is in use.

## 2. Provider protocol

```python
# workers/temporal-worker/src/transcription/provider.py

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class TranscriptSegment:
    """Provider-agnostic segment shape.

    The MVP REALTIME path (see `pipecat-pipeline.md` §9) writes only
    `{speaker, text}` — segment-level timing was dropped because the
    LLM side has no symmetric source for it. CANONICAL providers,
    however, run on the full audio and naturally produce per-utterance
    timestamps. We carry `start_ms` / `end_ms` / `confidence` here so
    canonical-aware consumers (a future audio-aligned playback view)
    can use them; the summary prompt and entry detail view ignore the
    extra fields. When CANONICAL is read back as plain JSON, REALTIME
    rows simply lack the timing keys — consumers must tolerate both
    shapes."""
    speaker: str            # "user" | "assistant" | "unknown"
    text: str
    start_ms: int
    end_ms: int
    confidence: float | None


@dataclass(frozen=True)
class CanonicalTranscript:
    """Return shape from a provider. Matches the fields we persist to
    the `transcripts` table, minus `id` / `call_session_id` / `created_at`
    which are stamped by `canonicalize_transcript` at insert time."""
    text: str                              # full text, newlines between turns
    segments: list[TranscriptSegment]      # ordered, non-overlapping
    word_count: int                        # precomputed, not derived in SQL
    provider_enum: str                     # "DEEPGRAM" | "WHISPERX" | "OTHER"
                                           # must match prisma TranscriptProvider enum


@runtime_checkable
class TranscriptProvider(Protocol):
    """Produces a canonical transcript from a stored recording.

    Contract:
      - Input is a URL to an audio file accessible to the provider
        (Twilio-hosted for MVP; signed URL into Neon Blob / Modal Volume
        later if retention needs grow).
      - Implementations MUST be stateless — the Temporal worker may
        instantiate one at module load and reuse it across activities.
      - Implementations MUST raise `ProviderUnavailableError` on any
        infrastructure failure (network, 5xx, auth, rate limit). The
        activity layer catches this and applies the fallback policy
        (§7). Data errors (malformed audio, empty response) raise
        `ProviderDataError`, which is non-retryable.
      - `await_transcribe` may be long-running; the caller applies the
        Temporal activity timeout. Implementations SHOULD NOT add
        their own timeouts shorter than 2 minutes.
    """

    async def transcribe(self, *, recording_url: str, call_sid: str) -> CanonicalTranscript:
        ...


class ProviderUnavailableError(Exception):
    """Transient — retry or fall through to fallback."""


class ProviderDataError(Exception):
    """Terminal for this recording — no retry will help."""
```

**Why `Protocol` and not an ABC:**
- `Protocol` is structural — adapters don't have to import-and-inherit the base. Lets us add a stub in tests without subclassing.
- `@runtime_checkable` lets us `isinstance(p, TranscriptProvider)` for dependency-injection wiring.
- No `__init__` contract is imposed; each provider takes whatever config it needs.

**Why `call_sid` is passed separately from `recording_url`:** Twilio recording URLs embed the call SID but the provider shouldn't parse URLs. WhisperX doesn't care about Twilio semantics; it just wants audio bytes. Keeping `call_sid` explicit makes it available for logging / tracing without URL regex.

## 3. MVP adapter — Deepgram batch

```python
# workers/temporal-worker/src/transcription/deepgram_batch.py

import httpx
from deepgram import DeepgramClient, PrerecordedOptions, UrlSource

from .provider import (
    TranscriptProvider, CanonicalTranscript, TranscriptSegment,
    ProviderUnavailableError, ProviderDataError,
)


class DeepgramBatchTranscriptProvider:
    """MVP canonical provider. Submits the Twilio recording URL to
    Deepgram's prerecorded API with diarization and utterance-level
    segmentation, returns a CanonicalTranscript with provider_enum="DEEPGRAM".

    The same vendor intentionally — zero new infra during the 3-day ship
    window. The accuracy gain over the streaming transcript comes from:
      (a) whole-audio context for word boundaries and punctuation,
      (b) `diarize=true` for speaker labels (vs frame-direction heuristic),
      (c) `utterances=true` for segment timing stable across re-runs.

    Switches to ModalWhisperXProvider (§4) post-MVP by swapping the
    worker bootstrap's `canonical_provider = ...` line.
    """

    def __init__(self, *, api_key: str) -> None:
        self._client = DeepgramClient(api_key=api_key)

    async def transcribe(self, *, recording_url: str, call_sid: str) -> CanonicalTranscript:
        options = PrerecordedOptions(
            model="nova-3-general",
            smart_format=True,
            punctuate=True,
            paragraphs=True,
            utterances=True,
            diarize=True,
            language="en",
        )
        try:
            response = await self._client.listen.asyncrest.v("1").transcribe_url(
                source=UrlSource(url=recording_url),
                options=options,
            )
        except httpx.HTTPStatusError as e:
            if 500 <= e.response.status_code < 600:
                raise ProviderUnavailableError(f"Deepgram 5xx: {e}") from e
            raise ProviderDataError(f"Deepgram 4xx: {e}") from e
        except (httpx.NetworkError, httpx.TimeoutException) as e:
            raise ProviderUnavailableError(f"Deepgram network: {e}") from e

        return _convert_deepgram_response(response)


def _convert_deepgram_response(response) -> CanonicalTranscript:
    """Extract utterances → TranscriptSegment list. Deepgram's
    diarize=true populates `speaker` as an int per utterance; map
    speaker 0 → "user" and all others → "assistant". For a two-party
    call this is accurate; the bot is consistently one voice (Deepgram
    Aura, e.g. `aura-2-thalia-en`) so clustering is stable.

    If diarization fails (one-speaker edge case), fall back to
    "unknown" for all segments rather than guessing — the REALTIME
    row is still speaker-attributed via frame direction, so the
    summary prompt can prefer REALTIME for speaker-aware generation
    and CANONICAL for text accuracy."""
    ...
```

**Why utterances and not words:** the `transcripts.segments` Json column is consumed by the summary prompt and the entry detail view. Neither needs per-word granularity. Utterances also deduplicate naturally across diarization — one speaker-coherent chunk per segment.

**Why speaker 0 → "user":** Twilio places the calling party (the user) first in the audio multiplex; the callee (our bot) is second. Deepgram clusters deterministically from audio features, so the mapping is stable across runs. If field data shows the mapping inverting, swap it in one place (`_convert_deepgram_response`) — callers don't see it.

**Idempotency:** Deepgram's batch API does not return a job ID we can re-query. Retries are straightforward re-submits — same URL, same options, same output (modulo model version pinning). Temporal retries are safe.

## 4. Future adapter — Modal + WhisperX (sketch)

```python
# workers/temporal-worker/src/transcription/modal_whisperx.py  (FUTURE)

import modal
from .provider import (
    TranscriptProvider, CanonicalTranscript, TranscriptSegment,
    ProviderUnavailableError, ProviderDataError,
)


# Modal function defined in a separate module owned by the Modal app.
# Deployed with `modal deploy`; the worker imports a stub and calls it
# over RPC. Cold starts are ~8–15s for a WhisperX container; warm starts
# are ~200ms. See §8 for how this interacts with activity timeouts.
_transcribe_whisperx = modal.Function.from_name(
    app_name="quotid-transcription",
    name="transcribe_whisperx",
)


class ModalWhisperXProvider:
    """FUTURE. Runs WhisperX on a Modal-hosted T4 GPU, with:
      - whisper-large-v3 backbone
      - wav2vec2 forced alignment for phoneme-level timestamps
      - pyannote diarization (speaker embedding + clustering)

    Accuracy gain over Deepgram batch is most visible on accented
    speech and sub-8kHz telephony audio. Also: Modal container can
    pre-warm to eliminate cold-start latency on scheduled nightly
    calls (fire at 21:00 local → Modal keep_warm kicks in at 20:55)."""

    async def transcribe(self, *, recording_url: str, call_sid: str) -> CanonicalTranscript:
        try:
            result = await _transcribe_whisperx.remote.aio(
                recording_url=recording_url,
                call_sid=call_sid,
            )
        except modal.exception.FunctionTimeoutError as e:
            raise ProviderUnavailableError(f"Modal timeout: {e}") from e
        except modal.exception.Error as e:
            raise ProviderUnavailableError(f"Modal infra: {e}") from e

        return CanonicalTranscript(
            text=result["text"],
            segments=[TranscriptSegment(**s) for s in result["segments"]],
            word_count=result["word_count"],
            provider_enum="WHISPERX",
        )
```

**Swap cost to flip MVP → future:** change one line in the worker bootstrap:

```python
# workers/temporal-worker/src/worker.py

# MVP:
canonical_provider: TranscriptProvider = DeepgramBatchTranscriptProvider(
    api_key=os.environ["DEEPGRAM_API_KEY"],
)

# Post-Modal:
canonical_provider: TranscriptProvider = ModalWhisperXProvider()
```

The activity (`canonicalize_transcript`) closes over whichever provider was injected. Nothing else changes — not the workflow, not the schema, not the journal pipeline.

## 5. Temporal activity + workflow placement

### 5.1 New activity

Adds one row to the activity catalogue in `temporal-workflow.md` §3:

| Activity | Run type | `start_to_close` | Retry | Invoked from |
|---|---|---|---|---|
| `canonicalize_transcript` | regular | **5 min** | custom: 2 attempts, backoff 30 s → 60 s | `JournalingWorkflow` (tail, optional) |

```python
# activities.py — appended to the existing activity module.

@dataclass(frozen=True)
class CanonicalizeTranscriptInput:
    call_session_id: str          # re-query recording_url, don't pass it through
                                  # — see §5.3


@dataclass(frozen=True)
class CanonicalizeTranscriptResult:
    transcript_id: str            # the freshly-inserted Transcript.id
    word_count: int
    provider_enum: str            # "DEEPGRAM" | "WHISPERX"


@activity.defn
async def canonicalize_transcript(
    inp: CanonicalizeTranscriptInput,
) -> CanonicalizeTranscriptResult:
    """Fetch `call_sessions.recording_url` (set by `store_entry`),
    call the injected TranscriptProvider, INSERT a `transcripts` row
    with kind=CANONICAL. The unique index on (call_session_id, kind)
    makes this idempotent: on retry after a partial success (transcribed
    but DB insert failed), the second INSERT collides and we re-read
    the existing row's id rather than duplicating.

    Raises:
      - ProviderUnavailableError → Temporal retries per policy
      - ProviderDataError → wrapped as ApplicationError(non_retryable=True)
      - ApplicationError(non_retryable=True) on missing recording_url
        (shouldn't happen — store_entry ran first — but guard anyway)"""
```

### 5.2 Workflow placement

**Where it slots into `JournalingWorkflow`:** appended as a tail step after `store_entry`, only on the `COMPLETED` branch, only when canonicalization is enabled.

```python
# workflows.py — additions to the existing workflow body.

_CANONICALIZE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=30),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=60),
    maximum_attempts=2,
    non_retryable_error_types=["ProviderDataError"],
)


# ...existing workflow body unchanged through `store_entry`...

# Step 6 — optional canonical transcription (tail).
# Guarded because MVP may ship before this feature is flipped on.
# See §7 for fallback policy when the activity exhausts retries.
if CANONICAL_TRANSCRIPT_ENABLED:
    try:
        await workflow.execute_activity(
            canonicalize_transcript,
            CanonicalizeTranscriptInput(
                call_session_id=session.call_session_id,
            ),
            start_to_close_timeout=timedelta(minutes=5),
            retry_policy=_CANONICALIZE_RETRY,
        )
    except ActivityError as exc:
        # Option (a) — silent skip. Canonical is background enhancement;
        # REALTIME row already covers the user-visible journal entry
        # (written by `store_entry` above). Log structured fields so the
        # failure is queryable in Temporal/log aggregation, then return.
        # See §7 for the full decision trace.
        workflow.logger.warning(
            "canonical_transcript_skipped",
            extra={
                "call_session_id": session.call_session_id,
                "user_id": session.user_id,
                "cause": exc.cause.__class__.__name__ if exc.cause else "unknown",
                "message": str(exc.cause) if exc.cause else str(exc),
            },
        )
```

**Why tail-of-same-workflow rather than a separate workflow or child workflow:**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Tail activity in `JournalingWorkflow` (chosen) | Zero new orchestration; reuses worker, retry, visibility. Tail runs after user-visible journal write, so failure here never blocks the product. | Extends workflow execution time by ~30 s typical. | ✅ MVP |
| Child workflow with `ParentClosePolicy.ABANDON` | Parent returns immediately. Independent retry history. | +1 workflow type, +1 workflow ID scheme, more moving parts. Overkill for MVP. | Consider if canonical runtime grows beyond ~2 min. |
| Separate workflow triggered from `store_entry` | Fully decoupled. | Requires `store_entry` activity to instantiate a Temporal client and start a workflow — unusual pattern, two coupling points. | No. |
| Backfill cron | Survives Temporal worker restarts during the canonical run. | Adds a scheduler, loses the correlation-with-call window, harder to reason about "did this call get canonicalized?" | No. |

The tail-activity choice assumes canonical runtime stays under ~2 min. Deepgram batch on a 10-min 8 kHz recording is typically ~15–30 s; WhisperX on Modal ~20–40 s warm. Revisit if tail dominates workflow execution time.

### 5.3 Why re-query `recording_url` instead of passing it through

Two reasons:

1. **Payload hygiene.** The `CallOutcome` object is already passed between `await_call`, `handle_missed_call`, `summarize`, and `store_entry` (`temporal-workflow.md` §3.1). Adding `recording_url` to `CallOutcome` pushes a field through four activity signatures that only one of them uses. Re-query is one SQL round-trip inside `canonicalize_transcript`.

2. **Source of truth.** `recording_url` is persisted by `store_entry` before `canonicalize_transcript` runs. Reading it back is "the DB is authoritative"; passing it through is "the workflow payload is authoritative." DB authority is simpler: if `store_entry` wrote it, canonical sees it; if not, canonical raises `ApplicationError` and stops.

**Resolved (session 3 audit, 2026-04-25):** `CallOutcome` now carries `recording_url: str | None` (`temporal-workflow.md` §3.1). The bot's `TranscriptCollector.build_outcome` is async and fetches the recording via `twilio_client.recordings.list(call_sid=..., limit=1)` (wrapped in `asyncio.to_thread`) at pipeline end (`pipecat-pipeline.md` §9). `store_entry` reads from `inp.outcome.recording_url`, persisting None when no recording landed (canonical transcription is silently skipped in that case via the §7 fallback policy).

## 6. Database semantics

No schema migration needed. Reuse what already exists in `prisma/schema.prisma`:

- `Transcript` with `@@unique([callSessionId, kind])` → at most one `REALTIME` + one `CANONICAL` per call. Writes to CANONICAL are idempotent: retry after partial failure hits the unique constraint, we re-read.
- `TranscriptKind.CANONICAL` → slot already there.
- `TranscriptProvider.DEEPGRAM` / `WHISPERX` / `OTHER` → covers MVP and future.

**Insert pattern (pseudocode, inside `canonicalize_transcript`):**

```python
# Prisma upsert ensures idempotency on retry.
transcript = await db.transcript.upsert(
    where={"call_session_id_kind": {
        "call_session_id": inp.call_session_id,
        "kind": "CANONICAL",
    }},
    create={
        "call_session_id": inp.call_session_id,
        "kind": "CANONICAL",
        "provider": result.provider_enum,
        "text": result.text,
        "segments": [dataclasses.asdict(s) for s in result.segments],
        "word_count": result.word_count,
    },
    update={
        # Post-provider-swap: let a later run overwrite an earlier
        # DEEPGRAM canonical with a WHISPERX one. Rare case, but the
        # operational story is "flip the flag, re-run backfill."
        "provider": result.provider_enum,
        "text": result.text,
        "segments": [dataclasses.asdict(s) for s in result.segments],
        "word_count": result.word_count,
    },
)
```

**Why `upsert` not `insert ... on conflict do nothing`:** the update branch lets a provider upgrade overwrite a stale row. If we wanted strict immutability, conflict-do-nothing is right; but since the purpose of CANONICAL is "the most accurate transcript we currently have the infrastructure to produce," upgrading it is the correct semantic.

## 7. Fallback policy — when canonical fails

Canonical transcription is background enhancement. It runs **after** the journal entry is already written (`store_entry` committed). Failure here must not retroactively fail the user-visible product.

### 7.1 Failure modes

| Cause | Class | Retry helps? |
|---|---|---|
| Deepgram 5xx / Modal infra | `ProviderUnavailableError` | Usually, on a second attempt minutes later |
| Twilio recording URL 403 / expired | `ProviderDataError` | No — retention window passed |
| WhisperX on malformed audio | `ProviderDataError` | No — bad input |
| Activity `start_to_close_timeout` (5 min) | Infra timeout | Maybe — longer runs on Modal cold start |
| Modal cold start + WhisperX first-run | Transient | Yes — second attempt hits warm container |

Temporal's 2-attempt retry policy covers the transient bucket. After retries exhaust, the activity raises `ActivityError` back to the workflow. What should the workflow do next?

### 7.2 Options

Pick one (or a combination). Tradeoffs:

| Policy | Pros | Cons |
|---|---|---|
| **(a) Silent skip** — log + `return`; no CANONICAL row written | Simplest. Product unaffected. | No operational signal that canonical is systematically failing. REALTIME stays as the only row. |
| **(b) Mark CallSession** — set a new `canonical_transcript_status` column to `"FAILED"` | Visible in DB for ops queries. Retryable via a maintenance script. | Requires a schema change. Adds a state machine to the CallSession row. |
| **(c) Queue for backfill** — enqueue a `CanonicalizeTranscriptWorkflow` to run tomorrow | Eventually-consistent canonical; survives provider outages. | +1 workflow type, +1 schedule, more moving parts. |
| **(d) User-visible flag** — show "canonical transcript unavailable" on the journal entry detail view | Honest with the user. | Exposes internals; the user doesn't care about canonical vs realtime. |
| **(e) Synchronous fallback provider** — on failure, try a second provider (e.g., Deepgram batch as fallback for Modal) | Highest chance of getting a canonical row. | Doubles the cost envelope; adds an ordering decision ("which provider first?"). |

### 7.3 Decision — option (a) silent skip + structured warning log

**Chosen:** option (a). The `except ActivityError:` block in §5.2 logs a structured `canonical_transcript_skipped` warning with `call_session_id`, `user_id`, cause class name, and message, then returns. No CANONICAL row is written for that call.

**Rationale:**

- **Product-safe by construction.** The journal entry is already committed by `store_entry` before this activity runs (§5.2 placement). A canonical failure cannot retroactively break the user-visible artifact.
- **Zero schema change.** Options (b), (c), and (d) all add columns, workflow types, or UI surface. The 3-day deadline can't absorb that.
- **Operational signal preserved.** Structured logging emits a queryable record (`temporal_visibility` + log aggregator). Day-of-ops can grep for `canonical_transcript_skipped` and count failures per provider, per day, without bespoke tracking.
- **Reversible.** If canonical failure rates turn out to matter post-MVP, upgrading from (a) to (b) is a single column + one assignment line. The decision doesn't paint a corner.

**Why not (e) synchronous fallback provider:** doubles cost on every failure and forces an ordering decision (Deepgram-first vs Modal-first) that has no clear answer until both are in production. Defer to post-MVP if canonical reliability becomes a metric we care about.

**Future migration path:** when Modal + WhisperX is wired in, this block stays the same. Modal failures route through `ProviderUnavailableError` (retryable; covered by `_CANONICALIZE_RETRY`) or `ProviderDataError` (terminal; lands here). The log line's `cause` field already differentiates them.

## 8. MVP behavior + feature flag

The flag `CANONICAL_TRANSCRIPT_ENABLED` in §5.2 exists so the MVP can ship with canonical transcription **defined but not wired** if the 3-day schedule pressures it out. Two shipping modes:

| Mode | Flag | Effect |
|---|---|---|
| **Minimal** | `False` | `canonicalize_transcript` activity is defined but never invoked. No second Transcript row. MVP journal entries use REALTIME only. |
| **Enabled** | `True` | Tail activity runs per call with Deepgram batch. CANONICAL rows populate; journal detail view can prefer CANONICAL text if present, REALTIME otherwise. |

**Recommendation:** ship Minimal for the demo, flip to Enabled post-deadline once Modal is provisioned. Rationale: Deepgram batch on MVP adds ~30 s to the workflow tail for an accuracy gain the interviewer won't notice in a 5-min demo.

Flag lives in the worker environment (`QUOTID_CANONICAL_TRANSCRIPT_ENABLED=true|false`). Read once at worker startup, captured in a workflow-visible constant. **Do not** read env vars from inside the workflow body — workflows must be deterministic (`temporalio.workflow` determinism rule).

## 9. Latency & cost envelope

**Deepgram batch (MVP canonical):**
- Request: ~5 s network + ~15–25 s Deepgram processing for a 10-min 8 kHz mono audio file.
- Cost: ~$0.0043/min for nova-3-general prerecorded, so ~$0.043 per 10-min call. Bundled with the existing Deepgram account; no new credentials or vendor.

**Modal WhisperX (future canonical):**
- Cold start: ~8–15 s container boot + model load on T4 GPU.
- Warm: ~20–40 s for a 10-min audio.
- Cost: ~$0.60/hr T4 × ~40 s = ~$0.007/call. Modal's per-second billing is critical here — a provisioned GPU idling for 24 hrs would cost ~$14/day, so rely on Modal's scale-to-zero and eat the cold-start latency, OR use `keep_warm=1` for the 21:00–22:00 window (~$0.60/day) if cold starts degrade nightly runs.

**Neither path pushes the workflow past the 30-min `execution_timeout`** in `temporal-workflow.md` §8. Headroom is comfortable.

## 10. Security / auth

- Twilio recording URLs are protected by HTTP Basic Auth (account SID + auth token). Deepgram's batch API accepts a URL and fetches it server-side, so the worker passes the URL with credentials embedded (`https://{sid}:{token}@api.twilio.com/...`). The URL lives in process memory only; never logged.
- Modal functions receive the recording URL as an RPC argument. Modal's transport is TLS + mTLS; the URL doesn't leak in logs unless we log it (don't).
- No new secrets introduced beyond what MVP already requires: Deepgram API key, Twilio credentials, (future) Modal token.

## 11. Open questions (defer until implementation)

1. **Deepgram batch response shape vs our `TranscriptSegment`.** The SDK returns a nested structure (`results.channels[].alternatives[].paragraphs.paragraphs[].sentences[]` plus `results.utterances[]`). `_convert_deepgram_response` in §3 is a stub; choose utterances (§3 recommendation) vs paragraphs (richer prose structure, no speaker labels) at implementation time.
2. **Speaker mapping when diarization fails.** §3 falls back to `"unknown"`. Alternative: use the REALTIME row's turn boundaries as a speaker-alignment template, since REALTIME has authoritative per-turn direction. Do this only if diarize-failure is common in practice.
3. **Retention for recording URLs.** Handoff §Decision 16 chose Twilio-hosted URLs for MVP (ephemeral). If the retention window (~24 hours by default, extendable) lapses before `canonicalize_transcript` runs, the URL 403s. Not a concern for the same-call tail-activity pattern in §5.2; becomes one if we switch to the "queue for backfill" fallback (§7 option c). Address only if that fallback is chosen.
4. **Provider versioning.** Both Deepgram and WhisperX models change over time. The `transcripts` row has no `model_version` field. Add as `provider_version String?` column on a future migration if we ever need to reprocess historical calls with a specific model generation.

---

**Step 6 status:** design locked. §7 fallback policy = option (a) silent skip + structured log. Ready for Day 3 scaffolding.
