# C4 — Container Diagram

The internals of Quotid: five containers on one Oracle Cloud VM, plus the external SaaS dependencies.

```mermaid
C4Container
  title Container Diagram — Quotid

  Person(user, "User", "Keeps a voice-driven journal")

  Container_Boundary(app, "Quotid (Oracle Cloud VM, Docker Compose)") {
    Container(caddy, "Caddy", "Go", "Reverse proxy + automatic TLS via Let's Encrypt")
    Container(nextjs, "Web App", "Next.js 16, TypeScript, TanStack Query", "UI, Server Actions, Route Handlers (incl. Twilio status webhook)")
    Container(pipecat, "Pipecat Bot Server", "Python, FastAPI", "Telephony bridge. Exposes /dialout, /twiml, /ws. Runs the STT→LLM→TTS pipeline per call.")
    Container(worker, "Temporal Worker", "Python", "Runs workflow activities: initiate_call, await_call, summarize, store_entry")
    Container(temporal, "Temporal Server", "Go (start-dev binary)", "Workflow orchestration engine")
    ContainerDb(volume, "Temporal State", "SQLite + Docker Volume", "Workflow history persistence")
  }

  System_Ext(twilio, "Twilio", "PSTN + Media Streams")
  System_Ext(deepgram, "Deepgram", "Nova-3 STT")
  System_Ext(openrouter, "OpenRouter", "LLM routing")
  System_Ext(cartesia, "Cartesia", "Sonic TTS")
  SystemDb_Ext(neon, "Neon Postgres", "Journal data")

  Rel(user, caddy, "Uses web UI", "HTTPS")
  Rel(twilio, user, "Rings phone", "PSTN")

  Rel(caddy, nextjs, "Forwards web traffic", "HTTP")
  Rel(caddy, pipecat, "Forwards /dialout, /twiml, /ws", "HTTP / WSS")

  Rel(nextjs, temporal, "Triggers workflows, queries state", "gRPC")
  Rel(nextjs, neon, "CRUD via Prisma", "Postgres wire")

  Rel(temporal, worker, "Dispatches activity tasks", "gRPC")
  Rel(temporal, volume, "Persists workflow history", "SQLite")

  Rel(worker, pipecat, "POST /dialout to initiate call", "HTTPS")
  Rel(worker, openrouter, "Summarize transcript (Sonnet)", "HTTPS")
  Rel(worker, neon, "Write journal entry via Prisma", "Postgres wire")

  Rel(pipecat, twilio, "calls.create + Media Streams", "REST + WSS")
  Rel(pipecat, deepgram, "Stream audio for STT", "WSS")
  Rel(pipecat, openrouter, "Per-turn LLM calls (Haiku)", "HTTPS")
  Rel(pipecat, cartesia, "TTS synthesis", "WSS")
  Rel(pipecat, worker, "Async activity completion on call end", "Temporal Python SDK")
```

## Design notes

- **Next.js is a single container, not split into frontend + API.** Next.js 16 App Router combines UI (Server Components + Client Components), mutations (Server Actions), and HTTP endpoints (Route Handlers) in one runtime. Splitting into a dedicated Node API server would create redundant types and an extra container for no gain at this scale.
- **Two callers into Pipecat.** The Temporal Worker hits `POST /dialout` to initiate a call; Twilio hits `GET /twiml` and the `/ws` WebSocket as part of call setup. Both route through Caddy; only `/ws` and `/twiml` are publicly reachable (Twilio needs them); `/dialout` can be restricted to localhost / Docker network via Caddy matcher.
- **Pipecat signals completion back to Temporal directly** using the Temporal Python SDK's `get_async_activity_handle(...).complete(payload)` call. The worker's `await_call` activity is registered with `raise_complete_async()` and unblocks when Pipecat reports. A Twilio `statusCallback` webhook into the Next.js app is a watchdog in case Pipecat crashes mid-call — it signals the workflow to time out gracefully.
- **Temporal Server uses `temporal server start-dev`** with a Docker volume holding SQLite state. This is the MVP choice; switching to Temporal Cloud is a config change (no architecture change).
- **Neon stays external.** Single managed Postgres, `DATABASE_URL` in env, Prisma connects from both the Next.js and Worker containers.
