# Quotid

Voice-agent journaling app. Built as portfolio + interview prep for telli.com (YC AI voice-agent startup); stack deliberately mirrors theirs.

**Status: shipped to production 2026-04-25.** End-to-end demo live at `https://quotid.johnmoorman.com`.

## Production

- **App:** `https://quotid.johnmoorman.com` (Next.js)
- **Bot:** `https://v.quotid.johnmoorman.com` (Pipecat WSS public; POST `/calls` is Caddy-403'd, internal only)
- **Host:** AWS Lightsail us-east-1, `3.214.75.222`, Ubuntu 22.04
- **Compose stack:** `temporal` (start-dev mode) · `worker` (Python Temporal) · `bot` (Pipecat FastAPI) · `web` (Next.js standalone) · `caddy` (auto-TLS)
- **DB:** Neon Postgres dev branch via Prisma; dual-URL pattern (`DATABASE_URL` pooled / `DIRECT_URL` direct for migrations)

## Local dev

Cloudflared tunnel `quotid-voice` (token-based, run via apt-installed `cloudflared`) routes:
- `quodev.johnmoorman.com` → `http://localhost:3000`
- `quovoice.johnmoorman.com` → `http://localhost:8000`

Five processes (separate terminals):
```bash
~/.temporalio/bin/temporal server start-dev --ui-port 8233
cd workers/temporal-worker && uv run python -m quotid_worker.main
cd apps/pipecat-bot && uv run uvicorn quotid_bot.server:app --host 0.0.0.0 --port 8000 --workers 1
npm run dev --workspace=@quotid/web
cloudflared tunnel --no-autoupdate run --token <TOKEN>
```

`.env` at repo root is symlinked into `apps/web/.env` so Next.js picks it up. **Login passcode:** `quotid2026`.

## Deploy

```bash
ssh ubuntu@3.214.75.222
cd ~/quotid && git pull
sg docker -c "bash scripts/deploy.sh"
```

`scripts/deploy.sh` is idempotent — installs Docker if missing, validates `.env`, runs `docker compose up -d --build`.

## Stack invariants — DO NOT re-litigate

- **Prisma 6, not 7.** v7 moved datasource to `prisma.config.ts`; ecosystem hasn't caught up.
- **cuid(), not cuid(2).** `prisma-client-python` 0.15 bundles a Prisma 5.x engine that doesn't parse `cuid(2)`. v1 cuid is 25-char and collision-safe enough for MVP.
- **Deepgram Aura TTS, not Cartesia.** Cartesia trial ran out mid-build. The empty-subclass Modal swap point (`QuotidDeepgramTTSService`) is preserved.
- **OpenAI service import path:** `pipecat.services.openai.llm`, not `pipecat.services.openai`. Pipecat 1.0.0 made it a package without top-level re-exports.
- **`@temporalio/client` async completion:** `client.activity.complete({workflowId, activityId}, payload)` directly. There is no `getAsyncCompletionHandle`.
- **Forwarded headers everywhere.** Behind cloudflared (dev) or Caddy (prod), `req.url` reflects internal `localhost:3000`. proxy.ts, all auth routes, the watchdog, and the bot `/twiml` all read `x-forwarded-proto` + `x-forwarded-host`.
- **`on_client_disconnected` cancels the pipeline task.** Without it `runner.run()` hangs after WSS close and the outcome never posts to Temporal.
- **`/api/webhooks/` is in `proxy.ts` PUBLIC_PREFIXES.** Twilio status callbacks must not be redirected to /login.
- **`uvicorn --workers=1` (single worker)** — bot has an in-process correlation registry (`call_sid → workflow_id`); multi-worker would split it.
- **Caddy 403s public POST `/calls`** (decision #14). Worker hits the bot via `BOT_INTERNAL_URL=http://bot:8000` over the docker network.
- **Per-user personalization chain.** `User.voicePreference` + `User.name` flow worker → bot via `CreateCallSessionResult.voice` / `.user_name` → `InitiateCallInput` → `CreateCallRequest` → `CallCorrelation` → `build_pipeline(voice=..., user_name=...)`. New per-user fields must follow this chain.
- **Transcript built by two frame processors** sharing one `TranscriptCollector`: `UserTranscriptCapture` (after STT) and `AssistantTextCapture` (after LLM, before TTS). Segments are appended chronologically as they fire — do NOT reconstruct order from `LLMContext.messages` (STT finalizes faster than TTS, so context order is unreliable). Opening line is seeded at construction. See `apps/pipecat-bot/quotid_bot/transcript_accumulator.py`.
- **System prompt forbids markdown.** TTS speaks asterisks/backticks literally. See `apps/pipecat-bot/quotid_bot/system_prompt.py`.
- **Voices stored as Deepgram model IDs.** `apps/web/app/(app)/settings/voices.ts` defines six Aura 2 voices (Thalia, Orion, Luna, Aries, Draco, Iris); IDs (`aura-2-*-en`) flow straight through to the bot's TTS.
- **Don't export non-functions from `"use server"` files.** They become `undefined` on the client at runtime. Shared data (e.g. `AVAILABLE_VOICES`) lives in a neutral module imported by both server actions and client components.
- **`/icon` and `/apple-icon` are in `proxy.ts` PUBLIC_PREFIXES** so Next's auto-generated icon routes aren't redirected to /login. Don't add new auth-exempt paths casually.
- **STT chosen by factory, not at the wire site.** `apps/pipecat-bot/quotid_bot/stt_factory.py` is the only place that picks the STT vendor. It returns `(service, label)` where `label` is a `TranscriptProvider` enum value. The label flows through `TranscriptCollector` → `CallOutcome.transcript_provider` → `Transcript.provider` column. Adding a provider: install the Pipecat extra, add a `match` case, add the value to Prisma's `TranscriptProvider` enum, set `STT_PROVIDER` env. Worker code never hardcodes the provider name.
- **Deepgram model: `nova-3-general`** (not Pipecat's `nova-2` default). Configured in `stt_factory.py`. ~50% lower WER than Nova-2 on noisy phone audio.
- **Twilio status webhook is NOT the human-pickup completion path.** `apps/web/app/api/webhooks/twilio/call-status/route.ts` only fires `complete_await_call`/`fail_await_call` when `(callStatus === "completed" && AnsweredBy is machine_*/fax)` OR when `callStatus` is in `no-answer/failed/busy/canceled`. Human `completed` events are owned by the bot's WSS handler — webhook racing them drops the journal entry (bot outcome takes ~5–10s to build). Requires Twilio AMD enabled (`machine_detection="Enable"` in `apps/pipecat-bot/quotid_bot/server.py`) so `AnsweredBy` is populated.
- **Twilio AMD enabled — `/twiml` branches on `AnsweredBy`.** `human`/`unknown`/unset → `<Connect><Stream/></Connect>` (normal pipeline); `machine_*`/`fax` → `<Hangup/>` (no WSS opens, webhook handles outcome). Adds ~$0.0075/call.
- **Live-call endpoints are internal-only.** Bot exposes `GET /calls/{call_sid}/transcript` and `POST /calls/{call_sid}/end`, backed by a parallel `_COLLECTORS: dict[str, TranscriptCollector]` registry keyed by `call_sid` (set in WSS handler, removed via `remove(call_sid)`). Web proxies via `BOT_INTERNAL_URL` over the docker network at `/api/call-sessions/[id]/transcript` and `/api/call-sessions/[id]/end`; both auth-gated by `proxy.ts`. `POST /calls/{sid}/end` also calls `fail_await_call(workflow_id, "user_ended")` so a voicemail-style hangup (WSS never opened) doesn't hang the workflow for 20 minutes.
- **`workflow.now()` substitutes for epoch `scheduled_for`.** Temporal Schedule's static args template can't reference fire time, so settings actions seed `new Date(0).toISOString()`; the workflow detects at-or-before-epoch input and replaces. Calls page also prefers `startedAt` over `scheduledFor` for display fallback.
- **`initiate_call` 4xx is non-retryable.** Bot catches `TwilioRestException` from `twilio.calls.create`/`.update` and forwards Twilio's HTTP status via `HTTPException`; worker's `_INITIATE_CALL_RETRY` treats 4xx as `non_retryable_error_types=["TwilioClientError"]`. Workflow wraps `initiate_call` in try/except and runs `handle_missed_call` on rejection, otherwise CallSession stays PENDING for 20 minutes.

## Commit style — enforced by PreToolUse hook

Subject-only. No body. No "feat:"/"fix:"/"docs:" prefix. No Co-Authored-By. No HEREDOC. Single `-m` flag. Tutorial-grade granularity (commit per logical change, not per task). The hook at `~/.claude/hooks/no-commit-body.sh` will physically block violations — don't try to circumvent.

## Common debug paths

| Symptom | Likely cause | Fix |
|---|---|---|
| Login redirects to wrong host | Forwarded-header handling broke | Check `req.headers.get("x-forwarded-host")` is reaching Next.js |
| Twilio status callback 403 | Signature verified against wrong URL | Watchdog must construct URL from forwarded headers |
| Workflow stuck `DIALING` | Bot crashed mid-call OR pipeline didn't terminate | Check `runner.run` exception path; verify `on_client_disconnected` registered |
| No journal entry after call | `store_entry` retries (3) exhausted on a Prisma error | `MissingRequiredValueError` → use `connect: {id}` for relations; `datetime` not `date` for entryDate; `prisma.Json(...)` wrapper for JSON fields |
| Bot won't reach worker | Wrong URL | Dev: `BOT_INTERNAL_URL=http://localhost:8000`. Prod: `http://bot:8000` (set in compose env override) |
| Recording 502 in prod / works on localhost | Empty `Content-Length` header forwarded to Caddy | Only forward `Content-Length` when upstream provides it. See `apps/web/app/api/journal-entries/[id]/recording/route.ts` |
| Call completes but no journal entry / CallSession ends `NO_ANSWER` | Webhook `AnsweredBy` filter regression OR Twilio AMD form param missing | Verify Twilio status callback payload includes `AnsweredBy`; webhook must skip `complete_await_call` for human `completed` events (bot owns that path) |

## Repo layout

```
quotid/
├── apps/
│   ├── web/                    # Next.js 16, Tailwind, TanStack Query, Prisma client
│   └── pipecat-bot/            # Python 3.12 + uv, FastAPI, Pipecat 1.0.0
├── workers/
│   └── temporal-worker/        # Python 3.12 + uv, Temporal SDK, prisma-client-python
├── prisma/
│   └── schema.prisma           # Single source of truth for DB schema
├── compose.yaml                # Production stack (5 services)
├── Caddyfile                   # quotid.* / v.quotid.* with auto-TLS
├── scripts/
│   └── deploy.sh               # Idempotent deploy on Lightsail
└── docs/
    ├── architecture/           # Current design (LikeC4, OpenAPI, pipecat, temporal)
    ├── architecture/deprecated/ # Stale Mermaid C4 + old session handoff
    └── superpowers/plans/      # Day-3 execution plan (historical)
```

## Outstanding work

Ordered by interview-impact:

1. **Missed-call entries** — `handle_missed_call` activity sets `CallSession.status=NO_ANSWER/FAILED` but the UI only lists `JournalEntry`s. Show a "we tried but couldn't reach you" pill on the journal list.
2. **Edit journal entry** — `body` + `generatedBody` separation exists in the schema for this; wire an edit form that sets `isEdited=true`.
3. **In-progress banner — finish wiring.** Status webhook flips `CallSession.status` to `IN_PROGRESS` on Twilio "answered" (`apps/web/app/api/webhooks/twilio/call-status/route.ts`), and `components/journal/status-card.client.tsx` renders the banner; verify polling cadence and DIALING-state coverage end-to-end.

Deferred indefinitely:

- **Modal + WhisperX canonical transcript** — `transcription-interface.md` design exists; flag is `CANONICAL_TRANSCRIPT_ENABLED`, currently unset.
- **Sliding-window session refresh** — fixed 30-day TTL until first re-login (skipped for MVP simplicity).
- **Public Temporal dashboard** — port 8233 is internal-only. SSH tunnel: `ssh -L 8233:localhost:8233 ubuntu@3.214.75.222`.
- **Multi-user** — schema is multi-user-shaped but `prisma.user.findFirst()` in the login route + single seeded user means only one human currently uses the system.

## Pointers

- **Architecture (current):** `docs/architecture/likec4/quotid.c4` (preview: `npx likec4 serve docs/architecture/likec4`), `docs/architecture/pipecat-pipeline.md`, `docs/architecture/temporal-workflow.md`, `docs/architecture/api/` (OpenAPI 3.1 + Server Actions)
- **Data model:** `prisma/schema.prisma`
- **Design history:** `docs/architecture/deprecated/` (early Mermaid C4s, old session handoffs), `docs/superpowers/plans/2026-04-25-day3-scaffolding.md` (the execution contract)
- **Memory:** `~/.claude/projects/-home-john-repos-quotid/memory/`

## User context

John Moorman, week 9 of a 10-projects-in-10-weeks challenge. Currently in Frankfurt; phone number `+4917630321460` (the verified Twilio recipient — placeholder `+15555550100` won't work on trial). Twilio FROM number `+18122203743`.
