# C4 — Deployment Diagram

Physical layout: one Oracle Cloud Always-Free Ampere A1 VM hosting the Docker Compose stack, with managed services reached over the public internet.

```mermaid
C4Deployment
  title Deployment Diagram — Quotid (Production)

  Deployment_Node(phone, "User's Phone", "Any carrier / PSTN") {
  }

  Deployment_Node(browser, "User's Browser", "Chrome / Safari / Firefox") {
  }

  Deployment_Node(oracle, "Oracle Cloud Ampere A1", "Always-Free, Ubuntu 22.04, 4 vCPU / 24 GB RAM") {
    Deployment_Node(compose, "Docker Compose", "Single-host orchestrator") {
      Container(caddy, "Caddy", "Go", "TLS + reverse proxy, ports 80/443")
      Container(nextjs, "Web App", "Next.js 16", "Internal port 3000")
      Container(pipecat, "Pipecat Bot Server", "Python / FastAPI", "Internal port 7860")
      Container(worker, "Temporal Worker", "Python", "Outbound only")
      Container(temporal, "Temporal Server", "Go start-dev", "Internal ports 7233 / 8233")
      ContainerDb(tempvol, "temporal-data volume", "Docker named volume", "SQLite state")
    }
  }

  Deployment_Node(neonCloud, "Neon Cloud", "Managed Postgres, us-east-1") {
    ContainerDb(neon, "quotid DB", "Postgres 16", "Journal data")
  }

  Deployment_Node(twilioCloud, "Twilio Cloud", "US edge") {
    Container_Ext(twilio, "Programmable Voice + Media Streams", "SaaS", "PSTN + WebSocket audio")
  }

  Deployment_Node(providers, "AI Providers", "Various") {
    Container_Ext(deepgram, "Deepgram", "SaaS", "STT Nova-3")
    Container_Ext(openrouter, "OpenRouter", "SaaS", "LLM gateway")
    Container_Ext(cartesia, "Cartesia", "SaaS", "TTS Sonic")
  }

  Rel(browser, caddy, "HTTPS", "443")
  Rel(phone, twilio, "PSTN")
  Rel(twilio, caddy, "Fetches TwiML; Media Streams WSS", "HTTPS / WSS 443")

  Rel(caddy, nextjs, "HTTP", "3000")
  Rel(caddy, pipecat, "HTTP / WSS", "7860")

  Rel(nextjs, temporal, "gRPC client", "7233")
  Rel(nextjs, neon, "Prisma / Postgres wire", "5432 TLS")

  Rel(worker, temporal, "gRPC client (task queue poll)", "7233")
  Rel(worker, pipecat, "HTTP to initiate dialout", "7860")
  Rel(worker, openrouter, "HTTPS", "443")
  Rel(worker, neon, "Prisma / Postgres wire", "5432 TLS")

  Rel(temporal, tempvol, "SQLite I/O")

  Rel(pipecat, twilio, "REST + WSS", "443")
  Rel(pipecat, deepgram, "WSS", "443")
  Rel(pipecat, openrouter, "HTTPS", "443")
  Rel(pipecat, cartesia, "WSS", "443")
  Rel(pipecat, worker, "Async activity completion via Temporal SDK", "gRPC to temporal:7233")
```

## Design notes

- **One host, one Compose file.** Everything except the database and external SaaS runs on a single Oracle VM. This is appropriate for a single-user MVP and keeps inter-service latency at loopback speeds for the voice path.
- **Only Caddy is publicly reachable.** All app containers bind to Docker's internal network; Caddy exposes 80/443 on the host. TLS is handled by Caddy with an ACME challenge via Let's Encrypt, using a user-owned subdomain.
- **Temporal dev-server persistence** uses a named Docker volume (`temporal-data`) holding SQLite state. Surviving restarts requires the volume; losing the volume loses workflow history (acceptable tradeoff for MVP).
- **Pipecat completes Temporal activities by calling the Temporal server over gRPC**, same channel the Worker uses — no extra HTTP layer between Pipecat and the orchestration engine.
- **Egress-only from compute containers.** No inbound access to Worker, Pipecat (except via Caddy for Twilio + dialout), Temporal (except via Caddy optionally for the UI at 8233 if exposed), or the volume. The Oracle VCN security list should block everything except 22/80/443 inbound.
- **Fallback host:** if Oracle ARM capacity is unavailable at signup (a known and recurring issue), substitute a Hetzner Cloud CAX11 (€3.79/mo, 2 vCPU / 4 GB ARM). The Compose file is portable.
