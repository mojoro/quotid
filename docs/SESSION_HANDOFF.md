# Quotid — Session Handoff

**Written:** 2026-04-24 (end of design session 2)
**For:** a fresh Claude Code session resuming this work, possibly on a different machine.

---

## First thing fresh Claude should say

> Read `docs/SESSION_HANDOFF.md` end-to-end. Steps 1–5 of the design phase are complete and audit-passed. Step 6 (Modal transcription interface) is the last remaining design step. The blocking open question is **"what does 'via WhatsApp' mean for the demo?"** (see §Open questions below) — answer that, confirm the Oracle region choice, and I'll write Step 6.

If the user says "just proceed," assume interpretation **C** for WhatsApp (meeting medium, not product integration) and assume **US East (Ashburn)** as the Oracle home region.

---

## Who / What / When

- **User:** John Moorman. Week 9 of a 10-projects-in-10-weeks challenge. User currently physically in Frankfurt; from the US.
- **Project:** Quotid — voice-agent journaling app. Temporal schedule fires at the user's local 9 pm, outbound call rings the user, Pipecat-driven voice agent has a Storyworthy-style conversation, transcript is summarized into a journal entry.
- **Deadline:** ship target ~2026-04-27 (~3 days from design start). **Portfolio + interview prep artifact**, not a production service.
- **Interview target:** telli (YC AI voice-agent startup, `telli.com`). Telli's public stack is TypeScript/React/TanStack, Node + Python, Postgres, **Temporal, Twilio, Modal, Pipecat**, Cartesia. Quotid's stack mirrors this intentionally.

## Target stack (locked)

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
| **Deferred** | Modal + WhisperX canonical transcript | Interface to be designed in Step 6 |

## Cost envelope

- **Infra**: ~$0/mo (Oracle Always-Free + Neon free tier + user's existing subdomain)
- **APIs**: ~$3–8 actual spend during build; signup credits likely cover all
- **Ongoing at 1 call/day**: ~$12–15/mo steady state
- User does NOT need the call to actually fire nightly — this is a demo-able portfolio artifact

## Design steps — status

| # | Step | Status | Authoritative source |
|---|---|---|---|
| 1 | C4 diagrams (LikeC4) | ✅ audit-passed | `docs/architecture/likec4/quotid.c4` |
| 2 | ERD / data model | ✅ | `prisma/schema.prisma` (generates `docs/architecture/erd.md`) |
| 3 | Temporal workflow | ✅ audit-passed | `docs/architecture/temporal-workflow.md` |
| 4 | API contract (OpenAPI 3.1 + Server Actions) | ✅ audit-passed, Zalando-aligned | `docs/architecture/api/` (README + 2 YAML specs + server-actions.md) |
| 5 | Pipecat pipeline | ✅ audit-passed | `docs/architecture/pipecat-pipeline.md` |
| 6 | Modal transcription interface | ⏳ **NEXT** | To be written. |
| 7+ | Scaffolding / implementation | ⏳ | Day 3 activity. |

All five completed design docs are self-contained, internally consistent, and have been audited against live library/platform docs (Temporal Python SDK, Prisma 6, Pipecat current API, Zalando RESTful API Guidelines, OpenAPI 3.1, RFC 9457).

## What's done — file inventory

### Step 1 — C4 Architecture ✅

**Authoritative source:** `docs/architecture/likec4/quotid.c4`
**Preview:** `npx likec4 serve docs/architecture/likec4`
**Build:** `npx likec4 build docs/architecture/likec4 -o docs/architecture/dist`
**README:** `docs/architecture/likec4/README.md`

Views: `index` (C1), `containers` (C2), `production` (deployment), `callFlow` + `callSequence` (dynamic). Session 2 audit fixed a line 88 bug where Caddy was shown forwarding `/calls` publicly — corrected to match decision #14 (Docker-network internal only).

**Stale Mermaid files** `docs/architecture/c4-*.md` are superseded by the LikeC4 source. User has declined deletion; leave them alone.

### Step 2 — ERD / Data model ✅

**Authoritative source:** `prisma/schema.prisma`
**Generator:** `prisma-erd-generator` emits `docs/architecture/erd.md` on every `npx prisma generate`.

Models: `User`, `CallSchedule` (1:1 with User via `@unique` on FK), `CallSession`, `Transcript` (unique per `(callSessionId, kind)`), `JournalEntry` (optional 1:1 with CallSession).
Enums: `CallStatus`, `TranscriptKind`, `TranscriptProvider` (Postgres native enums, `@@map`ped).
IDs: `cuid(2)` — Prisma-native cuid2.
Neon dual-URL pattern: `DATABASE_URL` (pooled via pgBouncer) + `DIRECT_URL` (bypass pooler for migrations).
Naming: Prisma PascalCase singular → DB `snake_case` plural via `@@map`.

### Step 3 — Temporal workflow ✅

**Authoritative source:** `docs/architecture/temporal-workflow.md`

Defines `JournalingWorkflow` (per-attempt, not per-user), 6 activity signatures with retry policies, schedule creation pattern, watchdog pattern, error taxonomy, idempotency keys, timeout summary. Python pseudocode provided; no implementation.

**Key patterns:**
- Async activity completion for `await_call` (20-min backstop, completed externally by Pipecat or watchdog webhook).
- `activity_id="await-call"` hardcoded so watchdog doesn't need a stored task token.
- Workflow IDs: scheduled path = `journal-{user_id}` + Temporal-auto-appended ISO-8601 fire time (verified behavior); manual path = `journal-{user_id}-manual-{YYYYMMDDTHHMMSS}` (**second precision**, session 2 audit changed from minute to second).
- `summarize` retry policy = 2× fixed 10 s (session 2 audit tightened from 3× exponential).
- `raise raise_complete_async()` — the function RETURNS an exception that MUST be raised; calling without `raise` silently makes the activity complete with None. Docstring in §3.1 calls this out.

### Step 4 — API contract ✅

**Authoritative sources:** `docs/architecture/api/`
- `README.md` — index, boundary map, WSS protocol (Twilio Media Streams), auth matrix, Zalando compliance table
- `pipecat-bot.openapi.yaml` — OpenAPI 3.1 spec for Pipecat Bot Server (3 REST endpoints + WSS documented in README §4)
- `nextjs.openapi.yaml` — OpenAPI 3.1 spec for Next.js Route Handlers (4 endpoints)
- `server-actions.md` — TypeScript signatures for Server Actions (not REST, not in OpenAPI)

**Zalando alignment: Option B** — `snake_case` on HTTP/JSON boundaries, `camelCase` in Server Actions (not REST). Only documented deviation: `/api` prefix (Next.js App Router convention). RFC 9457 Problem Details. Cursor pagination with `(sort_field_value, id)` compound tiebreaker. `q` substring-search param deliberately omitted for MVP (YAGNI; add later if needed).

**Known gaps (intentional deferrals):** auth login/logout Route Handlers (`POST /api/auth/{login,logout}`) not yet specified. Passcode-on-User was the chosen default but the session-issuance flow needs design before scaffolding the web surface.

### Step 5 — Pipecat pipeline ✅

**Authoritative source:** `docs/architecture/pipecat-pipeline.md`

Defines pipeline topology, turn detection (Silero VAD + `LocalSmartTurnAnalyzerV3`), interruption handling, audio format (μ-law 8 kHz wire, PCM 8 kHz internal), TTS subclass hierarchy with Modal seam (decision #7), `TranscriptAccumulator` (custom `FrameProcessor`), latency budget (~980 ms typical, ~2.1 s worst case; target 1.0–1.5 s), error handling, open implementation questions.

**Key patterns:**
- Pipeline: `transport.input() → stt → transcript_accumulator → user_aggregator → llm → tts → transport.output() → assistant_aggregator`.
- `TranscriptAccumulator(context)` reads user-side transcripts from `TranscriptionFrame`s with audio timestamps, assistant-side turns from `LLMContext.messages` at pipeline end. Merge happens in `build_outcome`.
- `filter_incomplete_user_turns` intentionally NOT set — redundant with SmartTurn, adds per-turn LLM cost (session 2 audit removed).
- `QuotidCartesiaTTSService` subclass = empty-body named swap point for future `ModalTTSService`.
- Bot Server MUST run `uvicorn --workers=1` — in-process correlation registry for `{call_sid → (wf_id, act_id, cs_id)}`.

## Key design decisions — DO NOT re-litigate

These are the decisions already settled. If the user wants to reopen any, engage, but surface that it's locked and ask what changed.

**Stack choices (locked in session 1):**
1. **Prisma 6, not 7** — v7 moved connection config to `prisma.config.ts`; ecosystem (Supabase, `prisma-erd-generator`) hasn't caught up.
2. **OpenRouter, not direct Anthropic** — one key, model selected per call. Prompt caching works through OpenRouter for Anthropic models.
3. **LLM split:** `anthropic/claude-haiku-4-5` for in-call turns (latency), `anthropic/claude-sonnet-4-6` for post-call summary (quality).
4. **Next.js merges frontend + API** — no dedicated Node service. Server Actions for internal mutations, Route Handlers for external + client-fetched reads.
5. **Oracle Cloud Ampere A1 Always-Free** (4 vCPU / 24 GB), Docker Compose, Caddy (not nginx). Fallback: Hetzner CAX11 €3.79/mo.
6. **Neon Postgres** dual-URL pattern: `DATABASE_URL` (pooled via pgBouncer) + `DIRECT_URL` (bypass pooler for DDL migrations).

**Temporal / call-flow patterns (locked in session 1, audited in session 2):**
7. **Temporal ↔ Pipecat handoff = async activity completion.** Worker's `await_call` activity calls `raise raise_complete_async()` (note the `raise`!). Pipecat or watchdog completes via `get_async_activity_handle(wf_id, "await-call").complete(payload)`. 20-min `start_to_close_timeout` backstop.
8. **Twilio `statusCallback` = watchdog** for Pipecat crashes. Signals workflow via `/api/webhooks/twilio/call-status` Route Handler. Only abnormal statuses (`no-answer`, `failed`, `busy`, `canceled`) trigger async completion; normal `completed` status is NOT forwarded (Pipecat is authoritative completer on happy path).
9. **"User didn't pick up" is a workflow branch, not an activity retry.** Twilio 5xx is retryable; `no-answer` is data, returned from the activity as a normal `CallOutcome`.
10. **Scheduling uses Temporal Schedules** (one per user, IANA timezone on `ScheduleSpec.time_zone_name`, calendar-spec-based at 21:00 local). Schedule fires with `journal-{user_id}` base workflow ID; Temporal auto-appends fire timestamp for uniqueness.
11. **Pipecat's `TTSService` base class is sufficient** for hosted→Modal swap. Subclass directly; no wrapper layer. `QuotidCartesiaTTSService` (MVP) and future `ModalTTSService` are siblings under `TTSService`.
12. **Audio format:** μ-law 8 kHz on Twilio leg, PCM 8 kHz internally. `PipelineParams(audio_in_sample_rate=8000, audio_out_sample_rate=8000)`.
13. **Latency target: 1.0–1.5 s voice-to-voice.** Sub-1 s is not realistic over PSTN (marketing claims assume WebRTC).

**Security / networking (locked in session 1):**
14. **Only Caddy is public.** Pipecat's `POST /calls` is Docker-network only (Caddy matcher excludes). Pipecat's `/calls/{sid}/twiml` and `/calls/{sid}/stream` are public because Twilio must reach them; authenticated via `X-Twilio-Signature` (including on the WSS upgrade request).

**Deferred (interface to be designed in Step 6):**
15. **Modal + WhisperX canonical transcript** — to be added as a second `Transcript` row (kind=`CANONICAL`) alongside the MVP realtime Deepgram transcript. No schema migration needed; the `TranscriptKind` enum already has the slot.

**Defaults chosen session 2 (settles session 1's open questions):**
16. Phone number → provision a new Twilio number. Passcode → on `User` table (no separate `AuthMethod`). Python worker DB access → `prisma-client-python` (typed, mirrors Next.js). Recording retention → Twilio-hosted URLs (ephemeral) for MVP.

**API naming (locked in session 2):**
17. **Zalando Option B:** `snake_case` on HTTP/JSON boundaries (Pipecat REST, Next.js REST, webhook bodies), `camelCase` in Server Actions (not REST, TS-native). `CallSid`/`CallStatus` etc. from Twilio kept PascalCase (Twilio's contract). One documented deviation: `/api` prefix on Next.js routes.

## Open questions — blocking Step 6 / scaffolding

**1. What does "via WhatsApp" mean for the demo?** (session 2, unresolved)

User said: *"the demo call will have to be made to a german number though, or via whatsapp"*. Interpretation matters:

- **A.** Live WhatsApp voice call → **not feasible** via programmable APIs. Would require redesign.
- **B.** WhatsApp voice messages (async audio) → feasible via Twilio WhatsApp Business API with media attachments, but is a **different pipeline** — no real-time turn-taking, no VAD/SmartTurn, no interruption handling. Current Pipecat design doesn't apply.
- **C.** WhatsApp is just the interviewer-facing meeting medium (screen share); product is still PSTN. Current architecture is fine.
- **D.** Fallback if Twilio PSTN doesn't work for regulatory/capacity reasons. Would mean rebuilding the voice pipeline.

**Most likely is C**, but confirm before proceeding. If it's A, B, or D, design needs rework.

**2. Oracle Cloud home region.** (session 2, awaiting question 1 answer)

- Home region is **permanent** per account; affects free tier availability.
- German phone demo → Frankfurt VM is slight voice-latency winner (~50–100 ms) but A1 capacity is historically bad there.
- US phone demo or WhatsApp path → **US East (Ashburn)** is colocated with Neon, Twilio US edge, Anthropic/Deepgram/Cartesia. A1 typically easier to provision.
- **Current recommendation: US East (Ashburn)** for operational reliability; fallback Phoenix if Ashburn A1 capacity unavailable. Deadline risk > voice polish for 3-day ship target.
- User should try provisioning the VM *today* regardless of code progress — A1 provisioning can take hours to days ("out of host capacity" retries).

**3. Auth login/logout flow.** (session 2, Step 4 known gap)

Route Handlers `POST /api/auth/login` and `POST /api/auth/logout` are referenced in the API spec's security schemes but not spec'd. Passcode-on-User was the chosen default. Needs ~10 min of spec work before web surface scaffolding. Shape expected: form POST with passcode → validate → issue `quotid_session` cookie → redirect.

**4. Step 5 open implementation questions** (defer until scaffolding):
- Cartesia voice selection (MVP: env var with one hardcoded voice).
- System prompt content (Storyworthy-style; prompt engineering post-scaffold).
- Conversation-end detection strategy (likely user-signal + 10-min hard cap).
- Barge-in during bot opening line (currently allowed; may want 3 s lockout).
- SmartTurn model-instance sharing across concurrent pipelines (benchmark during impl).

## Next actions — priority order

1. **Resolve open question #1** (WhatsApp interpretation) — 2 minutes.
2. **Resolve open question #2** (Oracle region) — 2 minutes + start A1 provisioning retry loop in background.
3. **Write Step 6** (Modal transcription interface) — ~30 min. Define `TranscriptProvider` Python protocol, MVP `DeepgramBatchTranscriptProvider` adapter, future `ModalWhisperXProvider` sketch, activity signature in `JournalingWorkflow` (optional canonical transcript step), fallback policy if Modal is down.
4. **Write auth login/logout spec** — ~10 min. Add to `nextjs.openapi.yaml` + update server-actions.md cross-refs.
5. **Begin scaffolding (Day 3)** — per the repo layout sketch below. Docker Compose + Caddyfile + app directories. Use `prisma generate` to emit the client; set up `temporal server start-dev`; FastAPI skeleton; Next.js 16 init.

## Repo state

Working directory: `/Users/john/repos/quotid` on this machine. Fresh session on another machine: clone the repo, everything needed is in git.

**Current tree (end of session 2):**

```
quotid/
├── .claude/
│   └── settings.local.json                    (gitignored)
├── .gitignore
├── .likec4/                                   (preview cache; gitignored)
├── docs/
│   ├── SESSION_HANDOFF.md                     ← this file
│   └── architecture/
│       ├── c4-context.md                      (stale Mermaid; leave alone)
│       ├── c4-containers.md                   (stale Mermaid; leave alone)
│       ├── c4-deployment.md                   (stale Mermaid; leave alone)
│       ├── c4-dynamic-call-flow.md            (stale Mermaid; leave alone)
│       ├── erd.md                             (generated by prisma-erd-generator)
│       ├── likec4/
│       │   ├── quotid.c4                      ← Step 1 source of truth
│       │   └── README.md
│       ├── temporal-workflow.md               ← Step 3 source of truth
│       ├── pipecat-pipeline.md                ← Step 5 source of truth
│       └── api/
│           ├── README.md                      ← Step 4 index + boundary map
│           ├── pipecat-bot.openapi.yaml       ← Step 4
│           ├── nextjs.openapi.yaml            ← Step 4
│           └── server-actions.md              ← Step 4
└── prisma/
    └── schema.prisma                          ← Step 2 source of truth
```

**Planned for Day 3 scaffolding:**

```
quotid/
├── compose.yaml                               ← Docker Compose
├── Caddyfile                                  ← Caddy config
├── apps/
│   ├── web/                                   ← Next.js 16
│   └── pipecat-bot/                           ← Python FastAPI + Pipecat
├── workers/
│   └── temporal-worker/                       ← Python Temporal worker
├── packages/
│   └── shared-types/                          ← optional: TS types generated from Prisma
└── prisma/
    └── schema.prisma
```

## Environment / communication notes for fresh Claude

- **User style**: terse-preferring ("caveman mode"), senior-level engineer, pushes back on hedging, wants specific cut lists. Exception: conceptual questions ("what is X") warrant ~200–400 word substantive explanations.
- **Learning output style** is used throughout — if asked conceptual questions, use normal explanatory prose.
- **For design work**, deliver the artifact then summarize; don't ask for permission repeatedly. User confirmed "no reason not to" tone is welcome.
- **MUST vs SHOULD matters**: user asked for Zalando alignment and drew the line at "MUST violations need strong structural reasons." Bring up rule-strength distinction when proposing tradeoffs.
- **Memory system**: this user's previous machine has `~/.claude/projects/-Users-john-repos-quotid/memory/` with user_role, project_quotid, project_decisions, reference_handoff files. All their content is subsumed by this handoff; a fresh session on a new machine doesn't need them.
- **The handoff itself** is the session-to-session source of truth. When meaningful progress happens, update this file before committing.

---

**Session 2 commits:** steps 3–5 docs, api/ directory, likec4 bug fix, gitignore, this handoff update. All in one atomic commit.
