# Modal-hosted Orpheus TTS — design

**Status:** spec, awaiting implementation plan
**Date:** 2026-04-27
**Scope:** dev-only experiment, behind env flag (`TTS_PROVIDER=modal_orpheus`); production stays on Deepgram Aura.

## Context

Quotid's pipecat pipeline ships with `QuotidDeepgramTTSService` — an empty subclass at `apps/pipecat-bot/quotid_bot/pipeline.py:32` that has stood as a deliberate "Modal swap point" since day 3 (decision #11 in the original design). This spec realizes that swap point, but **without retiring Aura**: a parallel TTS path lives behind `TTS_PROVIDER`, defaulting to `deepgram` in prod.

The portfolio framing is "I built a Modal-hosted self-hosted-LLM TTS path; here's the cost trade-off and the architecture." The deliverable is the path itself plus a way to demo it locally; production continuity is non-negotiable.

## Goals

1. Stand up Orpheus 3B (`canopylabs/orpheus-3b-0.1-ft`, Apache 2.0) as a Modal service on L4 GPU with scale-to-zero.
2. Implement a pipecat `TTSService` subclass that streams PCM audio chunks from the Modal endpoint into the existing pipeline.
3. Gate the swap on a single env var so production deployment is untouched until the flag is flipped.
4. Document the cold-start trade-off and emotion-tag steerability as the talking points the experiment was built to demonstrate.

## Non-goals

- Replacing Aura in production.
- Per-user choice between Aura and Orpheus voices in the settings UI.
- Voice cloning (Orpheus supports it; out of scope).
- Sub-utterance text streaming on the bot side (pipecat already aggregates by sentence; we keep that contract).
- Pre-warm endpoints, automatic Aura fallback on Modal failure, or production cutover.

## Architecture

### High-level flow

```
                  TTS_PROVIDER=deepgram (prod default)
                  ──────────────────────────────────────►  Aura

  pipecat                                                  ┌─────────────────┐
  pipeline ─── text ──┐  TTS_PROVIDER=modal_orpheus        │ Modal app       │
                      ├──────────────────────────────────► │ orpheus_tts     │
                      │  HTTPS POST /synthesize            │ L4, scale-to-0  │
                      │  ◄── chunked PCM 16-bit @24kHz ─── │ Cls.synthesize  │
                      └────────────────────────────────────┴─────────────────┘
                                  │
                                  ▼
                         pipecat resamples to 8kHz
                         → Twilio media stream
```

### Components

**1. `modal_app/orpheus_tts/` — separate uv project, separate `pyproject.toml`**

A standalone Modal app, deliberately not inside `apps/pipecat-bot` so it doesn't pull in pipecat's deps. Owns its own dep tree (Modal SDK, transformers, snac decoder, torch).

```
modal_app/orpheus_tts/
├── pyproject.toml               # Modal + ML deps only
├── README.md                    # deploy/test/cost notes; emotion-tag vocabulary
├── orpheus_tts/
│   ├── __init__.py
│   └── app.py                   # Modal Cls, FastAPI endpoint
└── scripts/
    └── smoke_test.py            # POST sample text, save WAV locally
```

**Modal `Cls` shape:**

- `@modal.enter()`: load Orpheus 3B + SNAC decoder weights into GPU memory; warmup pass on a 5-token prompt to compile CUDA graphs.
- `@modal.method()` `synthesize(text: str, voice: str) -> AsyncGenerator[bytes]`: tokenize, generate audio tokens autoregressively, decode SNAC frames as they arrive, yield PCM chunks (~50-100ms of audio each).
- `@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)` `/synthesize`: thin wrapper that calls the method and returns `StreamingResponse(media_type="application/octet-stream")`.
- Container config: `gpu="L4"`, `min_containers=0`, `scaledown_window=120`, `timeout=300`, `image=modal.Image.debian_slim().pip_install(...)`.

**2. `apps/pipecat-bot/quotid_bot/modal_orpheus_tts.py` — pipecat TTS service**

Subclass of pipecat's `TTSService` base.

- `run_tts(text, context_id)`: opens `httpx.AsyncClient.stream("POST", url, ...)`, yields `TTSStartedFrame` then iterates over chunks; each chunk yields a `TTSAudioRawFrame(audio=chunk, sample_rate=24000, num_channels=1)`; finishes with `TTSStoppedFrame`. Pipecat's transport handles the 24 kHz → 8 kHz resample for Twilio.
- Auth headers: `Modal-Key` / `Modal-Secret` from config.
- On HTTP error or stream failure: log error, yield `ErrorFrame`. No fallback to Aura — this path is opt-in via flag and the failure mode is part of the demo's honesty.
- On `cancel()`: close the stream cleanly so Modal's container can scale down.

**3. `apps/pipecat-bot/quotid_bot/pipeline.py` — branch on flag**

```python
if CONFIG.tts_provider == "modal_orpheus":
    tts = ModalOrpheusTTSService(
        url=CONFIG.modal_orpheus_url,
        token_id=CONFIG.modal_token_id,
        token_secret=CONFIG.modal_token_secret,
        voice="tara",
    )
else:
    tts = QuotidDeepgramTTSService(
        api_key=CONFIG.deepgram_api_key,
        voice=voice or DEFAULT_VOICE,
    )
```

Voice argument from `CreateCallSessionResult.voice` is **ignored** when Orpheus is active (Aura voice IDs don't map). Hardcoded to `tara` (Orpheus default English female, warm tone — closest analogue to the current Aura Thalia default).

**4. `apps/pipecat-bot/quotid_bot/config.py` — new fields**

- `tts_provider: Literal["deepgram", "modal_orpheus"]` (default `"deepgram"`)
- `modal_orpheus_url: str | None`
- `modal_token_id: str | None`
- `modal_token_secret: str | None`

Validation: when `tts_provider == "modal_orpheus"`, the three Modal fields must be present; raise on startup otherwise.

**5. `apps/pipecat-bot/quotid_bot/system_prompt.py` — conditional emotion-tag block**

Append a paragraph to the system prompt **only when** `TTS_PROVIDER=modal_orpheus`, documenting the supported tags:

```
You may include the following inline tags to add prosody:
<laugh>, <chuckle>, <sigh>, <gasp>, <groan>, <yawn>, <sniffle>, <cough>.
Use them sparingly, only where they would feel natural to a thoughtful
listener. Do NOT use any other XML or markdown.
```

Aura would speak `<sigh>` literally — gating on the env var is a hard requirement.

**6. Repo-root `.env` additions** (documented; not committed)

```
TTS_PROVIDER=deepgram                              # or modal_orpheus
MODAL_ORPHEUS_URL=https://<workspace>--quotid-orpheus-tts-synthesize.modal.run
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

## Data flow per utterance

1. LLM emits a sentence: `"Mm, that sounds heavy. <sigh> Want to say more?"`
2. Pipecat's sentence aggregator hands the string to `ModalOrpheusTTSService.run_tts`.
3. Bot opens `POST {modal_url}/synthesize` with `{text, voice: "tara"}` and Modal proxy auth headers.
4. Modal container (warm or cold-started ~30-45 s on first call after idle):
   1. Tokenizes text including emotion tags.
   2. Streams audio tokens from Orpheus, decoded through SNAC into PCM chunks.
   3. Each chunk (~50-100 ms of audio) flushed to the HTTP response immediately.
5. Bot yields `TTSAudioRawFrame` for each chunk; pipecat begins playback before synthesis finishes.
6. End of stream → `TTSStoppedFrame`. Bot's HTTP connection closes.

## Failure modes (explicit)

| Mode | Behavior | Mitigation |
|---|---|---|
| Cold start (~30-45 s) | First sentence after idle has dead-air until first chunk arrives | Documented; pipecat's opening line will land slow on first call. Acceptable per scope C. |
| Modal endpoint 5xx | `ErrorFrame` propagated; pipeline fails out | No auto-fallback. Flag-driven, opt-in failure surface. |
| Stream truncation mid-utterance | Audio cuts off; pipecat ends turn | Same — error logged, no silent recovery. |
| OOM on L4 | Modal restarts container (~30 s outage) | Set `timeout=300`; one retry inside `run_tts` is acceptable but not required for first cut. |
| Local dev without Modal deployed | `tts_provider=deepgram` is the default; Orpheus path is unreachable unless the dev sets the flag | No code change needed. |

## Testing strategy

- `modal_app/orpheus_tts/scripts/smoke_test.py`: hits the deployed endpoint with a short test sentence, decodes the streaming PCM, writes a WAV to disk, prints first-byte latency. Run after `modal deploy`.
- `apps/pipecat-bot` integration: existing local-dev flow — set `TTS_PROVIDER=modal_orpheus` in `.env`, run a real call against the dev Twilio number, listen.
- No automated unit tests for the TTS service in this iteration; pipecat's `TTSService` contract is too transport-coupled to mock cheaply, and the manual smoke path covers the failure surface for a dev-only experiment.

## Cost model

| Item | Active rate | Idle rate | Demo cost (10 calls × 1 min, ~6 sentences/call) |
|---|---|---|---|
| L4 GPU | $0.000222/sec | $0 (scale-to-zero) | ~60 sentences × ~400 ms synth ≈ 24 sec ≈ $0.005 |
| Cold-start amortization | — | — | ~1-2 cold starts × 30-45 s × $0.000222 ≈ $0.02 |
| **Total per demo** | | | **~$0.03** |

Compared to Aura's ~$0.018/min × 10 min = $0.18 per same demo. Cost framing on the README will be honest: "scale-to-zero makes idle cost zero; per-call cost is comparable to Aura at demo volume; the win at production volume would be amortizing the warm container against a continuous stream of calls, which Quotid doesn't have."

## Out of scope (carried forward)

- Production cutover to Orpheus
- Per-user voice mapping between providers
- UI surface in settings page
- Pre-warm via UI button
- Aura→Modal fallback on error
- Sub-utterance streaming from pipecat to Modal (already handled the other direction; reverse direction is a pipecat-internal concern)

## Open questions to resolve at planning time

1. Modal proxy auth vs. a custom shared-secret header — Modal's built-in is simpler; confirm it works behind the bot's `httpx` setup.
2. `snac` decoder version pinning — the Canopy reference uses a specific commit; mirror it.
3. Whether to commit `modal_app/orpheus_tts/uv.lock` (yes — same convention as the rest of the repo).
4. Whether to add a `make` or `just` target for `modal deploy` to keep the muscle-memory tight.

These are wired-up details for the implementation plan, not architectural unknowns.
