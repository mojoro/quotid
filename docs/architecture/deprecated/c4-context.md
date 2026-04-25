# C4 — System Context

Shows Quotid from 30,000 ft: one user, one product, and the external systems it integrates with.

```mermaid
C4Context
  title System Context — Quotid

  Person(user, "User", "Keeps a voice-driven journal")

  System(quotid, "Quotid", "Voice-agent journaling. Calls the user nightly, turns the conversation into a journal entry.")

  System_Ext(twilio, "Twilio", "Outbound PSTN calls + Media Streams audio transport")
  System_Ext(deepgram, "Deepgram", "Real-time speech-to-text (Nova-3)")
  System_Ext(openrouter, "OpenRouter", "LLM routing (Claude Haiku in-call, Sonnet post-call)")
  System_Ext(cartesia, "Cartesia", "Real-time text-to-speech (Sonic)")
  SystemDb_Ext(neon, "Neon Postgres", "Managed Postgres for journal data")

  Rel(user, quotid, "Sets schedule, reads entries", "HTTPS")
  Rel(quotid, user, "Places nightly call", "PSTN via Twilio")

  Rel(quotid, twilio, "Places calls; streams μ-law audio", "REST + WebSocket")
  Rel(quotid, deepgram, "Streams call audio for STT", "WebSocket")
  Rel(quotid, openrouter, "LLM completions", "HTTPS")
  Rel(quotid, cartesia, "TTS synthesis", "WebSocket")
  Rel(quotid, neon, "Journal data", "Postgres wire")
```

## Design notes

- **LLM routing through OpenRouter, not direct Anthropic.** One key, one bill, multiple models behind a single base URL. Pipecat's `OpenAILLMService` targets OpenRouter's OpenAI-compatible endpoint; model is selected per call (`anthropic/claude-haiku-4-5` in-call for latency, `anthropic/claude-sonnet-4-6` post-call for summary quality).
- **Modal + WhisperX deliberately omitted.** The canonical-transcript path is designed-but-deferred (see Step 6). MVP uses Deepgram's real-time transcript as canonical. The `TranscriptProvider` interface in the Temporal workflow absorbs the future swap without diagram change.
- **Neon is shown as external** rather than bundled into the Quotid boundary because it's operationally independent (managed service, not a container we deploy).
