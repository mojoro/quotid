# Quotid — Session Handoff

**Written:** 2026-04-24 (end of design session 1)
**For:** a fresh Claude Code session resuming this work on 2026-04-25

---

## Who / What / When

- **User:** John Moorman. Week 9 of a 10-projects-in-10-weeks challenge.
- **Project:** Quotid — a voice-agent journaling app. A Temporal schedule fires at the user's local 9 pm, an outbound call rings the user, a Pipecat-driven voice agent has a Storyworthy-style conversation, and the transcript is summarized into a journal entry.
- **Deadline:** ~3 days from today (target ship: ~2026-04-27). This is a **portfolio + interview prep** artifact, not a production service.
- **Interview target:** telli (YC AI voice-agent startup, `telli.com`). Telli's public stack is TypeScript/React/TanStack, Node + Python, Postgres, **Temporal, Twilio, Modal, Pipecat**, Cartesia. Quotid's stack mirrors this intentionally.

## Target stack (final, post-decisions)

| Layer | Tool | Notes |
|---|---|---|
| Frontend | Next.js 16 App Router, TypeScript, Tailwind | No separate frontend container |
| API | Next.js Route Handlers + Server Actions | No dedicated Node API service |
| Data fetching | **TanStack Query** | Primary learning goal |
| Voice | Python Pipecat bot server (FastAPI) | Exposes `/calls`, `/calls/{sid}/twiml`, `/calls/{sid}/stream` |
| Orchestration | Python Temporal worker + `temporal server start-dev` | Python chosen because Pipecat + Modal SDK are Python |
| DB | **Neon Postgres** via Prisma 6 | **Not Prisma 7** — ecosystem lag |
| Hosting | **Oracle Cloud Always-Free Ampere A1** | 4 vCPU / 24 GB free; fallback Hetzner CAX11 €3.79/mo |
| Proxy / TLS | Caddy (auto Let's Encrypt) | Not nginx |
| Containers | Docker Compose | Single-host |
| Telephony | Twilio (PSTN + Media Streams, μ-law 8 kHz) | |
| STT | Deepgram Nova-3 streaming | |
| LLM | OpenRouter — `anthropic/claude-haiku-4-5` in-call, `anthropic/claude-sonnet-4-6` post-call | Single API key |
| TTS | Cartesia Sonic | Free tier covers demo |
| **Deferred** | Modal + WhisperX canonical transcript | Interface designed, not implemented |

## Cost envelope
- **Infra**: ~$0/mo (Oracle Always-Free + Neon free tier + user's existing subdomain)
- **APIs**: ~$3–8 actual spend during build; signup credits likely cover all
- **Ongoing at 1 call/day**: ~$12–15/mo steady state
- User does NOT need the call to actually fire nightly — this is a demo-able portfolio artifact

## What's done — file inventory

### Step 1 — C4 Architecture ✅

**Authoritative source:** `docs/architecture/likec4/quotid.c4`
**Preview:** `npx likec4 serve docs/architecture/likec4`
**Build:** `npx likec4 build docs/architecture/likec4 -o docs/architecture/dist`
**README:** `docs/architecture/likec4/README.md`

Views defined:
- `index` — C1 System Context (user + Quotid + external SaaS)
- `containers` — C2 Container (5 containers on Oracle VM + Neon)
- `production` — **Supplementary** Deployment (physical topology)
- `callFlow` — Supplementary Dynamic (graph)
- `callSequence` — Supplementary Dynamic (`variant sequence` UML-style)

**Stale files to delete (or leave, low priority):** `docs/architecture/c4-*.md` — earlier Mermaid versions superseded by the LikeC4 source. Kept because user hasn't confirmed deletion. If asked, delete them — they will drift.

### Step 2 — ERD / Data model ✅

**Authoritative source:** `prisma/schema.prisma`
**Generator:** `prisma-erd-generator` emits `docs/architecture/erd.md` on every `npx prisma generate`.

Models: `User`, `CallSchedule` (1:1 with User via `@unique` on FK), `CallSession`, `Transcript` (unique per `(callSessionId, kind)`), `JournalEntry` (optional 1:1 with CallSession).
Enums: `CallStatus`, `TranscriptKind`, `TranscriptProvider` (Postgres native enums, `@@map`ped).
Neon dual-URL pattern: `DATABASE_URL` (pooled via pgBouncer) + `DIRECT_URL` (bypass pooler for migrations).
Naming: Prisma PascalCase singular → DB `snake_case` plural via `@@map`.

### Step 4 — API contract 🟡 (partial)

Route map drafted per Zalando REST guidelines (nouns for routes, verbs only for function/activity names):

**Pipecat Bot Server (FastAPI):**
- `POST /calls` — create outbound call (caller: Temporal worker)
- `GET /calls/{call_sid}` — inspect state (ops/debug)
- `GET /calls/{call_sid}/twiml` — TwiML for Twilio
- `WSS /calls/{call_sid}/stream` — Media Streams

**Next.js Route Handlers:**
- `POST /api/webhooks/twilio/call-status` — watchdog webhook
- `GET /api/journal-entries` — list (supports `?q`, `?cursor`, `?limit`, `?sort`)
- `GET /api/journal-entries/{id}` — detail
- `GET /api/call-schedules` — list

**Server Actions (internal RPC, not REST):** `updateCallSchedule`, `triggerTestCall`, `updateJournalEntry`, `deleteJournalEntry`.

Full OpenAPI spec not yet written. Documented deviation from Zalando: using `/api` prefix (Next.js convention, coexists with rendered pages).

## Key design decisions — DO NOT re-litigate

1. **Temporal ↔ Pipecat handoff = async activity completion.** Worker activity calls `activity.raise_complete_async()` after passing `wf_id + activity_id` to Pipecat via `POST /calls`. Pipecat calls `temporal_client.get_async_activity_handle(wf_id, activity_id).complete(payload)` on session end. `start_to_close_timeout = 20 min` as backstop.
2. **Twilio `statusCallback` = watchdog** for when Pipecat crashes. Signals workflow via the `/api/webhooks/twilio/call-status` Route Handler.
3. **"User didn't pick up" is a workflow branch, not an activity retry.** Twilio 5xx is retryable; `no-answer` is data.
4. **Scheduling uses Temporal Schedules (one per user, IANA timezone)**, not cron workflows or in-workflow sleep loops.
5. **Only Caddy is public.** Pipecat's `/calls` POST is Docker-network only (Caddy matcher); `/twiml` and `/stream` are public because Twilio needs them.
6. **Next.js merges frontend + API** — no dedicated Node service. Server Actions for internal mutations, Route Handlers for external + client-fetched reads.
7. **Pipecat's `TTSService` base class is sufficient** for hosted-to-Modal swap. Subclass directly; no wrapper layer.
8. **OpenRouter, not direct Anthropic.** One key, model selected per call (`anthropic/claude-haiku-4-5` in-call, `anthropic/claude-sonnet-4-6` summary). Prompt caching works through OpenRouter for Anthropic models.
9. **Prisma 6, not 7.** v7 moved connection config to `prisma.config.ts`; ecosystem (Supabase, likely `prisma-erd-generator`) hasn't caught up. Revisit post-launch.
10. **LLM split:** Haiku 4.5 for in-call turns (latency), Sonnet 4.6 for post-call summary (quality).
11. **Audio format:** μ-law 8 kHz on Twilio leg, PCM internally. Set `PipelineParams(audio_in_sample_rate=8000, audio_out_sample_rate=8000)` on Pipecat.
12. **Latency target: 1.0–1.5 s voice-to-voice.** Sub-1 s is not realistic over PSTN (marketing claims assume WebRTC).

## Open questions the user should answer before Step 3

1. **Phone number** — use an existing Twilio number or buy one as part of MVP setup?
2. **Passcode storage** — on `User` table directly, or separate `AuthMethod` table? (I recommend on User for MVP.)
3. **Python worker DB access** — `prisma-client-python` (typed, matches Next.js) or `asyncpg` + hand-written SQL (lighter, more Pythonic)?
4. **Recording retention** — keep Twilio's hosted URL (ephemeral) or copy recordings to user-owned object storage?

If user doesn't answer, proceed with: existing Twilio number (assume they'll buy/provision one), passcode on User, `prisma-client-python` for consistency, Twilio-hosted URLs for MVP.

## Task status

| # | Step | Status |
|---|---|---|
| 1 | C4 diagrams (LikeC4) | ✅ completed |
| 2 | ERD / data model (Prisma schema) | ✅ completed |
| 3 | Temporal workflow | ⏳ **NEXT** |
| 4 | API contract | 🟡 in_progress (route map done, OpenAPI pending) |
| 5 | Pipecat pipeline | ⏳ pending |
| 6 | Modal integration (architected, deferred) | ⏳ pending |

## Plan for tomorrow

**Day goal:** finish all remaining design (Steps 3, 4, 5, 6) so day 3 is pure scaffolding.

1. Fresh Claude reads this handoff end-to-end.
2. Ask user for answers to the 4 open questions (or note the defaults used).
3. **Step 3 — Temporal workflow design**:
   - `JournalingWorkflow` class signature + state machine
   - Activities: `sync_schedule`, `initiate_call`, `await_call` (async completion), `summarize`, `store_entry`, + watchdog-triggered `handle_missed_call`
   - Retry policies per activity (which are retryable, which are non-retryable `ApplicationError`)
   - Schedule creation pattern (one Temporal Schedule per `CallSchedule` row)
   - Deliver as a design doc + Python pseudocode signatures; no implementation yet.
4. **Step 4 — Finish API contract**: write OpenAPI 3.1 spec for the Next.js Route Handlers + Pipecat server. There is an `openapi-spec-generation` skill available; consider invoking it.
5. **Step 5 — Pipecat pipeline design**: STT→LLM→TTS graph with turn detection (Silero VAD + SmartTurnAnalyzer), interruption handling, Twilio serializer config, TTS service class hierarchy showing where the future Modal adapter slots in.
6. **Step 6 — Modal interface**: define the `TranscriptProvider` Python protocol that both the Deepgram-batch MVP adapter and the future `ModalWhisperXProvider` will implement. Activity signature + fallback policy.

## Environment / communication notes for fresh Claude

- **Caveman communication mode is active** via a session-start hook. Default to terse fragment-style prose. Exceptions: **code/commits/security write normal prose**; **teaching/learning-style questions** also warrant normal explanatory prose. The user invokes `/caveman-help` if they want the mode reference.
- **Learning output style** was used throughout this session. The user frequently asked "what is X" (PSTN, PCM, gRPC, pgBouncer, DDL, UML vs ERD) and expected ~200–400 word substantive explanations with tables and practical takeaways. Continue this register for conceptual questions.
- **User style**: pushes back on over-conservative recommendations, wants specific cut lists over hedging, values honest assessments. Will challenge architectural choices — respond with reasoning, not deference.
- **Greenfield execution mode hook** is active. Do not park in planning — but respect explicit user requests for design work (which this entire session has been).
- **Vercel plugin session context** is injected but only apply when the user's request is Vercel-adjacent. Quotid does not deploy to Vercel (Oracle VM + Docker Compose).

## Repo state

Current working directory: `/home/john/repos/quotid` (NOT a git repo yet). Contents:

```
quotid/
├── .claude/settings.local.json
├── docs/
│   ├── SESSION_HANDOFF.md                 ← this file
│   └── architecture/
│       ├── c4-context.md                  ← stale Mermaid (delete when confirmed)
│       ├── c4-containers.md               ← stale Mermaid (delete when confirmed)
│       ├── c4-deployment.md               ← stale Mermaid (delete when confirmed)
│       ├── c4-dynamic-call-flow.md        ← stale Mermaid (delete when confirmed)
│       └── likec4/
│           ├── quotid.c4                  ← authoritative architecture source
│           └── README.md
└── prisma/
    └── schema.prisma                      ← authoritative data model source
```

Planned on day 3:

```
quotid/
├── compose.yaml                           ← Docker Compose
├── Caddyfile                              ← Caddy config
├── apps/
│   ├── web/                               ← Next.js 16
│   └── pipecat-bot/                       ← Python FastAPI + Pipecat
├── workers/
│   └── temporal-worker/                   ← Python Temporal worker
├── packages/
│   └── shared-types/                      ← optional: TS types generated from Prisma
└── prisma/
    └── schema.prisma
```

---

**First thing for fresh Claude to say:** "Read SESSION_HANDOFF.md end-to-end. Answer these 4 open questions so I can proceed with Step 3 (Temporal workflow design): [list the 4 questions]."
