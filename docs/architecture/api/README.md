# API Contracts — Quotid

**Scope:** Step 4 of the design phase. Canonical request/response contracts for every cross-process boundary in the system.

## What's in this directory

| File | Purpose | Consumers |
|---|---|---|
| [`pipecat-bot.openapi.yaml`](./pipecat-bot.openapi.yaml) | OpenAPI 3.1 spec for the Pipecat Bot Server (FastAPI). REST endpoints only; WSS documented in this README §4. | Temporal worker (calls `POST /calls`), Twilio (hits `/twiml`), ops humans. |
| [`nextjs.openapi.yaml`](./nextjs.openapi.yaml) | OpenAPI 3.1 spec for Next.js Route Handlers (`/api/*`). | Browser (via TanStack Query), Twilio (hits `/api/webhooks/twilio/call-status`). |
| [`server-actions.md`](./server-actions.md) | TypeScript signatures for Next.js Server Actions. Not REST; internal-only RPC invoked via React `<form action={...}>` or `useActionState`. | Quotid UI only. |

## Boundary map

```
┌────────────┐  POST /calls  ┌──────────────┐  calls.create  ┌────────┐
│  Temporal  │──internal────►│   Pipecat    │───────────────►│ Twilio │
│  worker    │               │  bot server  │                │        │
└────────────┘               │  (FastAPI)   │◄──────────────►│ PSTN   │
                             └──────────────┘   /twiml,WSS   └───┬────┘
                                                                 │
                                                     /api/webhooks/twilio/
                                                       call-status (watchdog)
                                                                 ▼
┌────────────┐   HTTPS       ┌──────────────┐                ┌────────┐
│  Browser   │──────────────►│   Next.js    │◄───────────────│ Twilio │
│ (TanStack  │               │  (App Router)│                └────────┘
│   Query)   │◄──────────────│  Route       │
└────────────┘    JSON       │  Handlers +  │
                             │  Server      │
                             │  Actions     │
                             └──────┬───────┘
                                    │ Prisma
                                    ▼
                             ┌──────────────┐
                             │ Neon         │
                             │ Postgres     │
                             └──────────────┘
```

## Zalando compliance + documented deviations

We follow the [Zalando RESTful API Guidelines](https://opensource.zalando.com/restful-api-guidelines/) as the HTTP-API style reference. Rule numbers cited where verified; see the linked source for exact current numbering.

| Zalando rule | Status | Note |
|---|---|---|
| **MUST** property names in `snake_case`, never camelCase | ✅ | Applies to both OpenAPI specs' JSON bodies. **Exception:** the `TwilioStatusCallback` request body is PascalCase (`CallSid`, etc.) because Twilio controls that wire format — documented inline in the nextjs spec. A 1-line Prisma→snake_case boundary codec (`snakecase-keys` on response, `camelcase-keys` on parsed request bodies) sits in the Route Handler layer. |
| **MUST** query parameters in `snake_case` (rule 130) | ✅ | Query params on `/journal-entries` are `q`, `cursor`, `limit`, `sort` — all single-word, no case ambiguity. `sort` values use snake_case enum (`entry_date`, `created_at`). |
| **MUST** path segments in `kebab-case` | ✅ | `/journal-entries`, `/call-schedules`, `/calls`, `/webhooks/twilio/call-status`. |
| Nouns for routes, verbs only for action/function names | ✅ | Routes are nouns; Server Action names (not in scope of Zalando, which is REST-only) are verbs: `updateCallSchedule`, `triggerTestCall`, etc. |
| Use plural nouns for collection resources | ✅ | All collection routes plural. |
| **MUST** support Problem JSON (RFC 9457; obsoletes RFC 7807) | ✅ | `application/problem+json` with `ProblemDetails` schema in both specs, including the standard fields `type`, `title`, `status`, `detail`, `instance`. `trace_id` added as a documented extension. |
| **SHOULD** prefer cursor-based pagination | ✅ | `GET /api/journal-entries` uses `?cursor=<opaque>&limit=<n>` with `next_cursor` in the response. `prev_cursor` / `first` / `last` links per Zalando's `ResponsePage` model intentionally omitted — single-user journal with chronological reads only; MVP YAGNI. |
| **SHOULD** only use UUIDs if necessary | ✅ | Using cuid2 via Prisma `@default(cuid(2))`. cuid2 is shorter, collision-resistant, and avoids the "UUIDs for everything" anti-pattern Zalando warns against. All ID columns are `String`, not `number`, preserving flexibility per the guideline. |
| Base URL convention (no `/api` segment) | ❌ **deviation** | Using `/api` prefix on Next.js. Rationale: App Router co-locates rendered pages (e.g., `/journal-entries` as a user-facing page) with API routes; the `/api` prefix disambiguates. Standard Next.js convention — no reasonable alternative without splitting services. Only documented deviation. |

### Not in Zalando scope

- **Server Actions** (see `server-actions.md`) use TS-native camelCase. They are internal RPC, not REST, and fall outside the Zalando guidelines' scope (which target HTTP APIs).
- **Temporal activity payloads** (`CreateCallRequest` aside) use Python-native snake_case — not wire-format REST, handled by Temporal's own serialization.

## 4. WebSocket endpoint: `WSS /calls/{call_sid}/stream`

Not in the OpenAPI spec because OpenAPI doesn't model async protocols. Documented here for completeness.

**Path:** `wss://{public-host}/calls/{call_sid}/stream`

**Initiated by:** Twilio Media Streams, after Twilio has received the TwiML response from `GET /calls/{call_sid}/twiml`. The TwiML `<Connect><Stream>` verb specifies this URL.

**Who's public:** public. Twilio reaches this from its own edge; Caddy forwards the WebSocket upgrade request. **Auth: `X-Twilio-Signature` header on the HTTP upgrade request**, validated with the Twilio signature-validation helper (same code path as the REST endpoints). Path-param unguessability is a secondary defense; optional source-IP allowlist can be layered on at Caddy for further hardening.

**Protocol:** Twilio Media Streams message format — JSON envelopes wrapping base64-encoded μ-law audio frames. See [Twilio Media Streams docs](https://www.twilio.com/docs/voice/media-streams/websocket-messages). Summary:

| Direction | Event | Payload |
|---|---|---|
| Twilio → Pipecat | `connected` | `{ protocol, version }` — handshake |
| Twilio → Pipecat | `start` | `{ streamSid, callSid, tracks, mediaFormat }` — stream metadata |
| Twilio → Pipecat | `media` | `{ track, chunk, timestamp, payload: <base64 μ-law> }` — inbound audio |
| Twilio → Pipecat | `mark` | `{ name }` — echo of outbound mark for sync |
| Twilio → Pipecat | `stop` | — call ended or WSS closed |
| Pipecat → Twilio | `media` | `{ streamSid, payload: <base64 μ-law> }` — outbound audio |
| Pipecat → Twilio | `mark` | `{ streamSid, name }` — barrier for tracking playback position |
| Pipecat → Twilio | `clear` | `{ streamSid }` — flush buffered outbound audio (for interruption) |

**Pipecat handles this via:** `TwilioFrameSerializer` from `pipecat.serializers.twilio`, wired into the pipeline's `FastAPIWebsocketTransport`. Not something the application code deals with directly.

## Authentication & authorization

| Endpoint | Auth mechanism | Notes |
|---|---|---|
| Pipecat `POST /calls` | Docker-network only (Caddy matcher excludes external) | Decision #14. No token; network is the auth boundary. |
| Pipecat `GET /calls/{sid}` | Docker-network only | Ops/debug, not client-facing. |
| Pipecat `GET /calls/{sid}/twiml` | Twilio signature verification | `X-Twilio-Signature` header validated against the request body + URL. |
| Pipecat `WSS /calls/{sid}/stream` | Twilio signature on the HTTP upgrade request | Same validation as the REST endpoints; verified before the WS is accepted. |
| Next.js `POST /api/webhooks/twilio/call-status` | Twilio signature verification | Same as TwiML endpoint; uses TypeScript Twilio SDK's `validateRequest`. |
| Next.js `GET /api/journal-entries*`, `/api/call-schedules` | Session cookie → passcode on User | MVP single-user: one passcode, validated by middleware, session cookie issued post-login. |
| Server Actions | Same session cookie (via `cookies()` in Next.js) | Per-action permission check; no endpoint-level auth. |

Security schemes declared in both OpenAPI specs under `components.securitySchemes`.

## Changelog

| Date | Change |
|---|---|
| 2026-04-24 | Initial contract (Step 4). |
