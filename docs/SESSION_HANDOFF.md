# Quotid — Session Handoff

**Written:** 2026-04-24 (end of design session 2); **updated** 2026-04-25 (sessions 3 + 4 — Step 6, auth spec, grilling, plan written + audit-fixed; ready to execute)
**For:** a fresh Claude Code session resuming this work, possibly on a different machine.

---

## First thing fresh Claude should do

**Design phase is complete. Grilling is complete. The Day 3 implementation plan is written, audited, and revised. You are picking up at the start of execution.**

The plan is at `docs/superpowers/plans/2026-04-25-day3-scaffolding.md` (revision r2 — see its top-of-file revision log for what was fixed in the audit pass before execution). It is structured for **subagent-driven execution**: 5 slices + 1 bonus, ~50 atomic tasks, each with exact file paths, full code, expected commands, and per-commit messages.

**Your literal first action:**

1. Greet the user briefly (one line — they're going to clear your context shortly anyway).
2. Invoke `superpowers:subagent-driven-development` skill via the Skill tool.
3. Read the plan once at `docs/superpowers/plans/2026-04-25-day3-scaffolding.md`. Extract every task's full text and "Files" block into your TodoWrite list before dispatching anything.
4. Confirm with the user that Pre-Task A (Oracle A1 provisioning retry loop) is running in parallel outside your session — it's their job, not yours.
5. Begin dispatching subagent-driven implementation starting with **Slice 1 Task 1.1**. Use the implementer prompt template; review each task with the spec-compliance reviewer THEN code-quality reviewer (in that order) before moving on.

**Hard constraints — failure-mode prevention:**

- **Commit style is enforced by a PreToolUse hook.** Subject-only, no body, no Conventional Commits prefix, no Co-Authored-By, no AI attribution. The hook will physically block any commit that uses multiple `-m` flags, a HEREDOC, `-F`, or newlines in the message. The plan's commit messages are already in this style — do not "improve" them. See `~/.claude/projects/-home-john-repos-quotid/memory/feedback_commit_style.md`.
- **Atomic commits.** Each commit = exactly one logical change. The plan already enforces this; do not bundle.
- **Push: never without explicit user consent.** The branch is many commits ahead of `origin/main` from prior sessions. Do not `git push` unless the user asks.
- **The plan is authoritative.** Do not improvise activity names, retry policies, file paths, or imports. They were audit-fixed against `docs/architecture/temporal-workflow.md` and `docs/architecture/pipecat-pipeline.md`. Any divergence you feel tempted to introduce should first surface as a question to the user.
- **Caveman mode** is active (terse prose, fragments OK) for talking to the user. Does NOT extend to code, security writeups, or commits.
- **Learning output style** is active. The plan calls out **Slice 1 Task 1.10 (TanStack hydration)** as a hands-on learning hotspot — surface this to the user when you reach that task; consider asking for a `TODO(human)` insertion at the `useQuery` call site.

**If `superpowers:subagent-driven-development` skill is unavailable**, fall back to `superpowers:executing-plans` with checkpoints. Either way, do not execute the plan inline without review checkpoints.

**External dependencies (Pre-Tasks B + C in the plan):** the user is responsible for capturing Twilio / Neon / Deepgram / OpenRouter / Cartesia / cloudflared credentials into `.env` before Slice 1 Task 1.1 lands. Verify with them before starting Task 1.3 (which needs `DATABASE_URL` + `DIRECT_URL`).

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
| 6 | Modal transcription interface | ✅ | `docs/architecture/transcription-interface.md` |
| 6.5 | Auth login/logout spec (closes Step 4 gap) | ✅ | `docs/architecture/api/nextjs.openapi.yaml` + `prisma/schema.prisma` |
| 7   | Pre-implementation grilling (16 architectural decisions) | ✅ session 4 | `docs/superpowers/plans/2026-04-25-day3-scaffolding.md` decision-summary table |
| 8   | Day 3 implementation plan | ✅ written, audited, revised (r2) | `docs/superpowers/plans/2026-04-25-day3-scaffolding.md` |
| 9+  | Scaffolding / implementation | ⏳ **NEXT — execute via `superpowers:subagent-driven-development`** | runs against the plan above |

All six completed design docs are self-contained, internally consistent, and have been audited against live library/platform docs (Temporal Python SDK, Prisma 6, Pipecat current API, Zalando RESTful API Guidelines, OpenAPI 3.1, RFC 9457).

The Day 3 plan was audited against the design docs in session 4 (2026-04-25) — found 7 CRITICAL bugs (notably the silent-deadlock `raise activity.raise_complete_async()` pattern, activity-name divergence from `temporal-workflow.md`, and a Caddy-public-vs-internal-URL bug in `initiate_call`). All CRITICAL + 8 of 10 IMPORTANT items fixed. See the plan's revision-log block at the top of the file.

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

**Modal + canonical transcript (Step 6, locked session 3):**
15. **Modal + WhisperX canonical transcript** — second `Transcript` row (kind=`CANONICAL`) populated by post-call `canonicalize_transcript` Temporal activity. MVP provider is `DeepgramBatchTranscriptProvider`; future swap to `ModalWhisperXProvider` is a one-line worker-bootstrap change. Tail-of-`JournalingWorkflow` placement; `CANONICAL_TRANSCRIPT_ENABLED` worker-startup flag. **Fallback policy:** silent skip + structured `canonical_transcript_skipped` warning log on `ActivityError` — canonical is background enhancement; product never blocks on it. Full design: `docs/architecture/transcription-interface.md`.

**Auth (session 3, closes Step 4 gap):**
18. **Passcode-on-User auth, server-side argon2id verification.** `User.passcodeHash` column. `POST /api/auth/login` issues a `quotid_session` cookie (HttpOnly, Secure, SameSite=Lax, Max-Age=2592000); `POST /api/auth/logout` deletes the row + clears the cookie. New `Session` model stores `(token, userId, expiresAt)`. 5/15min IP rate limit on login. Logout idempotent — works without a valid cookie.

**Defaults chosen session 2 (settles session 1's open questions):**
16. Phone number → provision a new Twilio number. Passcode → on `User` table (no separate `AuthMethod`). Python worker DB access → `prisma-client-python` (typed, mirrors Next.js). Recording retention → Twilio-hosted URLs (ephemeral) for MVP.

**API naming (locked in session 2):**
17. **Zalando Option B:** `snake_case` on HTTP/JSON boundaries (Pipecat REST, Next.js REST, webhook bodies), `camelCase` in Server Actions (not REST, TS-native). `CallSid`/`CallStatus` etc. from Twilio kept PascalCase (Twilio's contract). One documented deviation: `/api` prefix on Next.js routes.

## Open questions — blocking scaffolding

**1. ~~WhatsApp interpretation.~~** **Resolved session 3:** interpretation **C** (interviewer-facing meeting medium; product remains PSTN). Architecture unchanged.

**2. ~~Oracle Cloud home region.~~** **Resolved session 3:** **US East (Ashburn)**. Action item: start A1 provisioning loop in parallel with Day 3 scaffolding. Fall back to Phoenix if Ashburn A1 capacity unavailable; fall back to Hetzner CAX11 (€3.79/mo) if Oracle A1 stays out-of-capacity through 2026-04-26.

**3. ~~Auth login/logout spec.~~** **Resolved session 3:** specced in `nextjs.openapi.yaml` + `User.passcodeHash` and `Session` model added to `prisma/schema.prisma`. See decision #18 above.

**4. Step 5 open implementation questions** (defer until scaffolding):
- Cartesia voice selection (MVP: env var with one hardcoded voice).
- System prompt content (Storyworthy-style; prompt engineering post-scaffold).
- Conversation-end detection strategy (likely user-signal + 10-min hard cap).
- Barge-in during bot opening line (currently allowed; may want 3 s lockout).
- SmartTurn model-instance sharing across concurrent pipelines (benchmark during impl).

## Next actions — priority order

1. **Start (or confirm) Oracle A1 provisioning retry loop in US East (Ashburn).** Out-of-host-capacity is the dominant failure mode; queue retries from a phone or background VM while coding. Falls through to Phoenix → Hetzner. The plan's Pre-Task A documents this.
2. **Confirm Pre-Task B + C credentials (Twilio, Neon, Deepgram, OpenRouter, Cartesia, cloudflared) are captured.** Fresh Claude verifies with the user before Slice 1 Task 1.3.
3. **Execute the Day 3 implementation plan via subagent-driven development.** Plan path: `docs/superpowers/plans/2026-04-25-day3-scaffolding.md`. Slice ordering and per-task content are locked. Skill: `superpowers:subagent-driven-development`.
4. **At Slice 4 Task 4.13** (first real end-to-end call), pause for the user — they need to be on their phone for the demo verification.
5. **At Slice 5 Task 5.7** (deploy + first call against deployed system), pause again — DNS, Caddy TLS issuance, and the second real call all need user-side verification.
6. **Bonus Slice 6** is a one-line placeholder. Only build if S1–S5 land before end of day 1; surface to the user before starting.

## Repo state

Working directory varies by machine: `/Users/john/repos/quotid` (macOS, session 1–2) or `/home/john/repos/quotid` (Linux, session 3). Both are clones of the same git repo. Fresh session on another machine: clone, everything needed is in git.

**Current tree (end of session 3):**

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
│       ├── transcription-interface.md         ← Step 6 source of truth (session 3)
│       └── api/
│           ├── README.md                      ← Step 4 index + boundary map (session 3: auth row added)
│           ├── pipecat-bot.openapi.yaml       ← Step 4
│           ├── nextjs.openapi.yaml            ← Step 4 + session 3 (auth login/logout)
│           └── server-actions.md              ← Step 4
└── prisma/
    └── schema.prisma                          ← Step 2 source of truth (session 3: passcodeHash + Session)
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

**Session 2 commits:** steps 3–5 docs, api/ directory, likec4 bug fix, gitignore, prior handoff update. All in one bundled commit (`8293f96`). That commit's bundling and `Co-Authored-By` footer **violate** the commit-style rules now in force (see "Commit style" below) but are baseline debt; not rewriting upstream of `8293f96`.

**Session 3 commits (12 atomic, oldest → newest, all subject-only):**

```
39059a5  Add User.passcodeHash column
089d72d  Add Session model
fc46df7  Add auth tag to nextjs OpenAPI spec
194b389  Spec POST /auth/login
a262588  Spec POST /auth/logout
f9a6d14  Add API README changelog entry for auth
3c8aca0  Fix stale precision claim in temporal-workflow §7
e411de7  Reframe schedule client as TypeScript in §4
ea81d78  Add recording_url to CallOutcome
727fa63  Reclassify sync_schedule as service function
32b437d  Add Step 6 transcription-interface design doc
cb4f6c2  Refresh session handoff (session 3)
```

A 13th commit will land for *this* handoff refresh after the restart guidance lines were added.

Branch is **12+ ahead of `origin/main` and unpushed**. Per global rule "do not push unless explicitly asked," fresh Claude should NOT push without confirmation.

**Soft inconsistencies (tracked, not blocking):**
- `docs/architecture/likec4/quotid.c4` does not model `worker → deepgram` (would be needed only when `CANONICAL_TRANSCRIPT_ENABLED=true`; MVP ships Minimal). Add the relationship at the same time the flag is flipped.
- `docs/architecture/erd.md` is stale — does not yet show `User.passcodeHash` or `Session`. Will regenerate on first `npx prisma generate` during Day 3 scaffolding.

## Commit style — DO NOT VIOLATE

Subject-only, tutorial-grade granularity. **No commit body, ever.** No Conventional Commits prefix (`feat:`/`fix:`/`docs:` is **not** John's style). No `Co-Authored-By`. No AI attribution. Imperative subject; if you'd write more than ~1 bullet of body, the commit needs to be split.

**Enforcement:** a `PreToolUse` hook at `~/.claude/hooks/no-commit-body.sh` (wired into `~/.claude/settings.json`) will **physically block** any `git commit` that uses multiple `-m` flags, a HEREDOC, `-F`, or newlines in the message. Don't try to circumvent it — it exists because John had to re-prompt this rule across many sessions.

**Memory:** see `~/.claude/projects/-home-john-repos-quotid/memory/feedback_commit_style.md` for the full rule and split heuristics. The `MEMORY.md` index in the same directory loads automatically.

## Tooling state at end of session 3

- `grill-me` skill installed (`~/.agents/skills/grill-me/`); use it for pre-implementation interrogation.
- `caveman:caveman-commit` skill is installed but **explicitly rejected** for John's commits — do NOT auto-invoke it when staging changes.
- Caveman mode active for prose responses (terse, fragments OK); does NOT extend to code, security writeups, or commits.
- Working tree clean as of this handoff write.
