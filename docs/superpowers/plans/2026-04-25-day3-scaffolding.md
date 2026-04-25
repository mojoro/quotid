# Quotid Day 3 Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a working end-to-end Quotid demo — log in, click a button, receive a phone call, hold a brief conversation, and watch a journal entry appear — deployed to a public URL on Oracle Cloud, in ~2 calendar days.

**Architecture:** Vertical slices, worker-first. Each slice ships an observable user-facing behavior end-to-end before moving on. Five slices plus a bonus: (1) auth + empty journal list, (2) Temporal `create_call_session` activity proving the Python/Prisma/Temporal seam, (3) manual call trigger UI wiring slice 2 to a button, (4) full call flow from button to summarized journal entry, (5) deploy to Oracle behind Caddy, (bonus 6) nightly schedule toggle if S1–S5 land early.

**Tech Stack:** Turborepo monorepo. Next.js 16 App Router (TypeScript, Tailwind, TanStack Query) at `apps/web`. Python 3.12 + uv for `apps/pipecat-bot` (FastAPI + Pipecat) and `workers/temporal-worker` (Temporal Python SDK + prisma-client-python). Prisma 6 against Neon Postgres (dev branch + prod branch, dual-URL pgBouncer pattern). Twilio (PSTN + Media Streams), Deepgram Nova-3 (STT), OpenRouter (Haiku 4.5 in-call, Sonnet 4.6 post-call), Cartesia Sonic (TTS). Oracle Cloud Always-Free Ampere A1 with Docker Compose + Caddy in production. cloudflared tunnel for local Twilio webhook delivery.

**Source decisions:** Pre-implementation grilling (session 4, 2026-04-25) settled 16 architectural branches. See `docs/SESSION_HANDOFF.md` for the design-phase context and `docs/architecture/` for authoritative design docs.

**Naming:** This document uses "proxy" for what was historically called middleware in Next.js — Next.js 16 renamed `middleware.ts` to `proxy.ts` (Node-only runtime, not configurable).

**Revision log:**

- **r1, 2026-04-25** — initial draft.
- **r2, 2026-04-25** — audit-fix pass before execution. Fixes:
  - **C1**: `await_call` activity uses `raise activity.raise_complete_async()` (was the silent-deadlock bug from `temporal-workflow.md` §3.1).
  - **C2**: activity names aligned to `temporal-workflow.md` (`create_call_session`, `initiate_call`, `await_call`, `handle_missed_call`, `summarize`, `store_entry`); restored NO_ANSWER/FAILED branch.
  - **C3**: workflow input is `JournalingWorkflowInput`, not bare `user_id: str`.
  - **C4**: task queue renamed `quotid-journal` → `quotid-main`.
  - **C5**: introduced `BOT_INTERNAL_URL` separate from `BOT_PUBLIC_URL` (`initiate_call` calls the bot's internal URL because Caddy 403s public POST `/calls`).
  - **C6**: Pipecat aggregator imports rewritten to use `LLMContextAggregatorPair` + `LLMUserAggregatorParams`; VAD/turn-analyzer moved onto user aggregator per `pipecat-pipeline.md` §4.
  - **C7**: opening-line bootstrap uses `task.queue_frames([TextFrame(OPENING_LINE)])` only.
  - **I1**: `prisma-client-python` uses default output path; imports become `from prisma import Prisma`.
  - **I2**: `WorkflowEnvironment.start_time_skipping(data_converter=…)` kwarg, no private-attribute hack.
  - **I3**: bundled commits split atomically (one activity per commit).
  - **I4**: added Task 1.12 to update `nextjs.openapi.yaml` to reflect 303-redirect login.
  - **I5**: added a smoke-verification step for the TS SDK async-completion method name.
  - **I7**: `summarize` matches design-doc retry policy (`maximum_interval=10s`) + 2-minute timeout.
  - **I8**: `store_entry` no longer clobbers `recordingUrl`; bot fetches it from Twilio in `build_outcome`.

---

## Decision summary (locked, do not re-litigate without surfacing change)

| # | Decision |
|---|---|
| 1 | Vertical slices, not horizontal layers |
| 2 | Worker-first slice ordering: S1 auth → S2 `create_call_session` → S3 trigger UI → S4 full call → S5 deploy → bonus S6 schedule |
| 3 | Turborepo + npm workspaces |
| 4 | Neon dev branch for local dev (no Postgres in compose) |
| 5 | uv for both Python projects |
| 6 | Compose runs prod only; native processes in dev |
| 7 | Single root `.env` (not per-app) |
| 8 | Defer `packages/shared-types` |
| 9 | `proxy.ts` hits DB on every request (Node runtime + Prisma) |
| 10 | Slice 1 uses Server Component + TanStack hydration |
| 11 | Login is a native HTML form posting to a Route Handler (303 redirect) |
| 12 | Tests on load-bearing seams only (~4–6 tests across argon2, login, create_call_session) |
| 13 | Slice 4 demo terminates by user hangup; Twilio `completed` status drives end |
| 14 | cloudflared for Twilio webhooks during slice 4 dev |
| 15 | Slice 6 (schedule toggle) is one-line placeholder, only built if S1–S5 land early |
| 16 | Login Route Handler accepts `application/x-www-form-urlencoded` (form) and returns 303 redirect; spec to be updated to reflect dual-content-type |

---

## Pre-work — kicks off in parallel with everything

Oracle A1 capacity in US East (Ashburn) is the dominant external risk. Provisioning may need many retries. Start this BEFORE coding and let it run while you work.

### Pre-Task A: Oracle A1 provisioning retry loop

**Files:** none in repo (this is infra setup outside the codebase).

- [ ] **Step A.1:** From the Oracle Cloud console, attempt to launch an `Ampere A1.Flex` instance in **US East (Ashburn)** with 4 OCPU / 24 GB RAM, Ubuntu 22.04 LTS, public IP, SSH key from `~/.ssh/id_ed25519.pub`. If it succeeds, skip to Pre-Task B.

- [ ] **Step A.2:** If you get `Out of host capacity`, set up a retry loop. Easiest: `oci compute instance launch ...` with a shell script that retries every 5 minutes (Oracle docs have the JSON template). Alternatively use a third-party retry tool such as `hitrov/oci-arm-host-capacity` running on a free-tier VPS or your laptop.

- [ ] **Step A.3:** If Ashburn stays out-of-capacity for >12 hours, switch the retry loop to **US West (Phoenix)** — cheaper to fall back than to keep waiting.

- [ ] **Step A.4:** If Phoenix also fails by 2026-04-26 morning, provision a Hetzner CAX11 (€3.79/mo, ARM, Falkenstein DC) instead. Adjust slice 5 to match (Hetzner has no free tier but is reliable).

### Pre-Task B: Twilio account + phone number

**Files:** `.env` (created later in slice 1).

- [ ] **Step B.1:** Sign up at twilio.com (free trial credit covers MVP build). Verify your personal phone number for trial-mode outbound calls.

- [ ] **Step B.2:** Buy one US phone number with Voice + SMS capability (~$1/mo).

- [ ] **Step B.3:** Capture `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (E.164). Store in a password manager for now; you'll write them to `.env` in slice 1 Task 1.

### Pre-Task C: External API keys

- [ ] **Step C.1:** Sign up at neon.tech, create a project named `quotid`, create a branch named `dev`, capture both connection strings (pooled and direct). The pooled string ends with `-pooler.<region>.aws.neon.tech`; the direct one omits `-pooler`.

- [ ] **Step C.2:** Sign up at deepgram.com, create an API key with Nova-3 access, capture `DEEPGRAM_API_KEY`.

- [ ] **Step C.3:** Sign up at openrouter.ai, add ~$5 credit, capture `OPENROUTER_API_KEY`.

- [ ] **Step C.4:** Sign up at cartesia.ai, capture `CARTESIA_API_KEY`. Pick a voice from their library; capture its UUID as `CARTESIA_VOICE_ID`.

- [ ] **Step C.5:** Install `cloudflared` (`brew install cloudflared` or follow the apt install for Debian/Ubuntu). Run `cloudflared tunnel login` and authorize against your Cloudflare-managed domain.

---
## Slice 1 — Auth and empty journal list

**Demoable outcome:** Visit `localhost:3000`, get redirected to `/login`, submit your passcode, land on `/journal-entries` rendering an empty list ("No entries yet — your first journal will appear after your nightly call."). Logout link clears the cookie and bounces back to `/login`.

**Estimated effort:** 4–5 hours.

**File map:**

| Path | Responsibility |
|------|---------------|
| `package.json` (root) | Turborepo root, workspaces declaration |
| `turbo.json` | Pipeline tasks (`dev`, `build`, `lint`, `test`) |
| `.env` | Single source for all secrets (gitignored) |
| `.env.example` | Committed template, no real values |
| `.gitignore` | Already exists; extend |
| `apps/web/package.json` | Next.js + TanStack Query + argon2 deps |
| `apps/web/tsconfig.json` | TypeScript strict |
| `apps/web/next.config.ts` | Defaults |
| `apps/web/postcss.config.mjs`, `apps/web/tailwind.config.ts` | Tailwind 4 |
| `apps/web/app/layout.tsx` | Root layout, TanStack `<QueryProvider>` |
| `apps/web/app/page.tsx` | Redirect to `/journal-entries` |
| `apps/web/app/login/page.tsx` | Login form (Server Component) |
| `apps/web/app/journal-entries/page.tsx` | Empty-list view (Server Component + dehydrate) |
| `apps/web/app/proxy.ts` | Session validation, redirect to `/login` if invalid |
| `apps/web/app/api/auth/login/route.ts` | Login Route Handler |
| `apps/web/app/api/auth/logout/route.ts` | Logout Route Handler |
| `apps/web/app/api/journal-entries/route.ts` | List endpoint (used by TanStack via prefetch) |
| `apps/web/lib/db.ts` | Prisma client singleton |
| `apps/web/lib/auth.ts` | argon2id wrappers, session helpers, `currentUserId()` |
| `apps/web/lib/query-client.ts` | TanStack Query factory + `<QueryProvider>` |
| `apps/web/lib/codec.ts` | camelCase ↔ snake_case codec for HTTP boundary |
| `apps/web/__tests__/auth.test.ts` | Argon2id unit test |
| `apps/web/__tests__/login-route.integration.test.ts` | Login Route Handler integration test |
| `apps/web/vitest.config.ts` | Vitest config |
| `prisma/seed.ts` | Inserts the single MVP user |

### Task 1.1: Initialize Turborepo and the monorepo skeleton

**Files:**
- Create: `package.json`, `turbo.json`, `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1:** From the repo root, run:

```bash
npm init -y
npm install -D turbo@latest typescript@latest
```

- [ ] **Step 2:** Replace the generated `package.json` with:

```json
{
  "name": "quotid",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["apps/*"],
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "db:migrate": "prisma migrate dev",
    "db:generate": "prisma generate",
    "db:seed": "tsx prisma/seed.ts"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.5.0",
    "prisma": "^6.0.0",
    "tsx": "^4.0.0"
  }
}
```

- [ ] **Step 3:** Create `turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev": { "cache": false, "persistent": true },
    "build": { "dependsOn": ["^build"], "outputs": [".next/**", "!.next/cache/**"] },
    "lint": {},
    "test": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 4:** Append to `.gitignore`:

```
# Env
.env
.env.local
.env.*.local

# Turborepo
.turbo

# Next.js
.next
out

# uv
.venv
__pycache__
*.pyc

# Vitest
coverage
```

- [ ] **Step 5:** Create `.env.example` (committed; placeholder values only):

```bash
# Neon Postgres (dev branch)
DATABASE_URL="postgresql://...-pooler.region.aws.neon.tech/quotid?sslmode=require"
DIRECT_URL="postgresql://....region.aws.neon.tech/quotid?sslmode=require"

# Twilio
TWILIO_ACCOUNT_SID="ACxxx"
TWILIO_AUTH_TOKEN="xxx"
TWILIO_PHONE_NUMBER="+1xxx"

# Voice / AI
DEEPGRAM_API_KEY="xxx"
OPENROUTER_API_KEY="sk-or-xxx"
CARTESIA_API_KEY="xxx"
CARTESIA_VOICE_ID="xxx"

# Bot URLs — TWO different values:
#   BOT_PUBLIC_URL  → Twilio reaches /calls/{sid}/twiml and /calls/{sid}/stream here.
#                     In dev: cloudflared subdomain. In prod: real domain via Caddy.
#   BOT_INTERNAL_URL → Worker calls POST /calls here. NEVER Caddy in prod
#                     (Caddy intentionally 403s public POST /calls — decision #14).
BOT_PUBLIC_URL="https://bot.example.com"
BOT_INTERNAL_URL="http://localhost:8000"

# App URL — Twilio reaches the statusCallback webhook here in dev/prod.
APP_PUBLIC_URL="https://app.example.com"

# Temporal
TEMPORAL_ADDRESS="localhost:7233"
TEMPORAL_NAMESPACE="default"
```

- [ ] **Step 6:** Create your real `.env` at repo root by copying `.env.example` and filling in the values you captured during pre-work. **Do not commit it.**

- [ ] **Step 7:** Run `npm install` to install root deps.

- [ ] **Step 8:** Commit. Two atomic commits per the project's commit-style rule:

```bash
git add package.json package-lock.json turbo.json .gitignore
git commit -m "Initialize Turborepo monorepo at repo root"

git add .env.example
git commit -m "Add .env.example with all required keys"
```

### Task 1.2: Scaffold Next.js 16 app

**Files:**
- Create: `apps/web/` (entire Next.js app via `create-next-app`)

- [ ] **Step 1:** From the repo root run:

```bash
npx create-next-app@latest apps/web \
  --typescript --tailwind --app --eslint \
  --src-dir=false --import-alias="@/*" --turbopack --no-git
```

Accept defaults for any other prompts. The generator creates `apps/web/` with App Router, Tailwind 4, TypeScript strict, and Turbopack dev/build by default.

- [ ] **Step 2:** Edit `apps/web/package.json` to scope its name and remove the local-only git that the generator may set up:

```json
{
  "name": "@quotid/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev --turbopack -p 3000",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3:** From the repo root, install Next-side deps:

```bash
npm install --workspace=@quotid/web @prisma/client @tanstack/react-query @tanstack/react-query-devtools @node-rs/argon2 zod
npm install --workspace=@quotid/web -D @tanstack/eslint-plugin-query vitest @vitejs/plugin-react @types/node @testing-library/react @testing-library/dom jsdom
```

(`@node-rs/argon2` chosen over `argon2` — Rust-backed via NAPI, prebuilt binaries, no node-gyp.)

- [ ] **Step 4:** Smoke test:

```bash
npm run dev --workspace=@quotid/web
```

Visit `http://localhost:3000`, see the Next.js starter page. Stop with Ctrl-C.

- [ ] **Step 5:** Commit:

```bash
git add apps/web package.json package-lock.json
git commit -m "Scaffold Next.js 16 app at apps/web"
```

### Task 1.3: Wire Prisma at repo root, run initial migration, seed the user

**Files:**
- Modify: `prisma/schema.prisma` (already exists; no changes needed unless migration drift)
- Create: `prisma/seed.ts`
- Modify: `package.json` (add `prisma.seed` config — done in Step 1.1 already)

- [ ] **Step 1:** Confirm `prisma/schema.prisma` is current — it should already include `User.passcodeHash` and the `Session` model. If `npx prisma format` produces edits, commit them as a separate commit before continuing.

- [ ] **Step 2:** Generate the client and run the initial migration against your Neon dev branch. (`DATABASE_URL` and `DIRECT_URL` come from `.env`.)

```bash
# .env loading: Prisma 6 reads .env automatically from project root
npx prisma migrate dev --name init
npx prisma generate
```

Expected: a new `prisma/migrations/<ts>_init/migration.sql` file, and `docs/architecture/erd.md` regenerates with `passcode_hash` and `sessions` table.

- [ ] **Step 3:** Create `prisma/seed.ts`:

```typescript
import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";

const prisma = new PrismaClient();

async function main() {
  const passcodeHash = await hash(process.env.SEED_PASSCODE ?? "letmein", {
    algorithm: 2, // argon2id
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await prisma.user.upsert({
    where: { email: "john@example.com" },
    update: { passcodeHash },
    create: {
      email: "john@example.com",
      phoneNumber: process.env.SEED_PHONE_NUMBER ?? "+15555550100",
      timezone: "America/Chicago",
      passcodeHash,
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
```

- [ ] **Step 4:** Append to root `package.json`:

```json
"prisma": {
  "seed": "tsx prisma/seed.ts"
}
```

- [ ] **Step 5:** Run the seed. **Set `SEED_PASSCODE` and `SEED_PHONE_NUMBER` in your environment for this run** so they don't end up hardcoded.

```bash
SEED_PASSCODE="<your-actual-passcode>" SEED_PHONE_NUMBER="+1<your-actual-phone>" npx prisma db seed
```

Expected: "Running seed command `tsx prisma/seed.ts`" and no error.

- [ ] **Step 6:** Verify in Neon's SQL editor:

```sql
SELECT id, email, phone_number, timezone FROM users;
```

You should see one row.

- [ ] **Step 7:** Commit (two atomic commits):

```bash
git add prisma/migrations prisma/schema.prisma docs/architecture/erd.md
git commit -m "Run initial migration against Neon dev branch"

git add prisma/seed.ts package.json
git commit -m "Add Prisma seed for the single MVP user"
```

### Task 1.4: argon2id helpers + unit test (load-bearing test #1)

**Files:**
- Create: `apps/web/lib/auth.ts`
- Create: `apps/web/__tests__/auth.test.ts`
- Create: `apps/web/vitest.config.ts`

- [ ] **Step 1:** Create `apps/web/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
  },
});
```

- [ ] **Step 2:** Write the failing test at `apps/web/__tests__/auth.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { hashPasscode, verifyPasscode } from "../lib/auth";

describe("argon2id passcode hashing", () => {
  it("verifies a correct passcode against its hash", async () => {
    const hash = await hashPasscode("hunter2");
    expect(await verifyPasscode("hunter2", hash)).toBe(true);
  });

  it("rejects an incorrect passcode", async () => {
    const hash = await hashPasscode("hunter2");
    expect(await verifyPasscode("wrong", hash)).toBe(false);
  });

  it("produces distinct hashes for the same passcode (random salt)", async () => {
    const a = await hashPasscode("hunter2");
    const b = await hashPasscode("hunter2");
    expect(a).not.toEqual(b);
  });
});
```

- [ ] **Step 3:** Run, confirm failure:

```bash
npm test --workspace=@quotid/web
```

Expected: FAIL — `Cannot find module '../lib/auth'`.

- [ ] **Step 4:** Implement `apps/web/lib/auth.ts`:

```typescript
import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./db";

const ARGON2_OPTS = {
  algorithm: 2 as const, // argon2id
  memoryCost: 19456,     // 19 MiB — OWASP minimum for argon2id
  timeCost: 2,
  parallelism: 1,
};

export async function hashPasscode(passcode: string): Promise<string> {
  return hash(passcode, ARGON2_OPTS);
}

export async function verifyPasscode(passcode: string, stored: string): Promise<boolean> {
  try {
    return await verify(stored, passcode);
  } catch {
    return false;
  }
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export const SESSION_COOKIE = "quotid_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function currentUserId(): Promise<string> {
  const id = (await headers()).get("x-user-id");
  if (!id) redirect("/login");
  return id;
}

export async function findValidSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { token },
    select: { userId: true, expiresAt: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;
  return session;
}
```

- [ ] **Step 5:** Create the Prisma client singleton at `apps/web/lib/db.ts`:

```typescript
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") global.__prisma = prisma;
```

- [ ] **Step 6:** Re-run tests, confirm pass:

```bash
npm test --workspace=@quotid/web
```

Expected: all 3 argon2 tests pass.

- [ ] **Step 7:** Commit (two commits):

```bash
git add apps/web/lib/db.ts
git commit -m "Add Prisma client singleton"

git add apps/web/lib/auth.ts apps/web/__tests__/auth.test.ts apps/web/vitest.config.ts
git commit -m "Add argon2id helpers with passing unit test"
```

### Task 1.5: Login Route Handler

**Files:**
- Create: `apps/web/app/api/auth/login/route.ts`

- [ ] **Step 1:** Implement `apps/web/app/api/auth/login/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  verifyPasscode,
  newSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/auth";

// In-memory rate limiter: 5 attempts per IP per 15 minutes.
// Sufficient for single-user MVP; primary brute-force defense is argon2 cost.
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return NextResponse.json(
      { type: "about:blank", title: "Too many attempts", status: 429 },
      { status: 429, headers: { "Retry-After": "900", "Content-Type": "application/problem+json" } }
    );
  }

  const ct = req.headers.get("content-type") ?? "";
  let passcode: string | undefined;
  let next: string | undefined;

  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await req.formData();
    passcode = form.get("passcode")?.toString();
    next = form.get("next")?.toString();
  } else {
    const body = await req.json().catch(() => ({}));
    passcode = body.passcode;
    next = body.next;
  }

  if (!passcode) {
    return redirectWithError(req, "missing", next);
  }

  const user = await prisma.user.findFirst({ select: { id: true, passcodeHash: true } });
  if (!user) {
    return redirectWithError(req, "no-user", next);
  }

  const ok = await verifyPasscode(passcode, user.passcodeHash);
  if (!ok) {
    return redirectWithError(req, "invalid", next);
  }

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await prisma.session.create({ data: { token, userId: user.id, expiresAt } });

  const target = next?.startsWith("/") ? next : "/journal-entries";
  const res = NextResponse.redirect(new URL(target, req.url), 303);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}

function redirectWithError(req: NextRequest, code: string, next?: string) {
  const url = new URL("/login", req.url);
  url.searchParams.set("error", code);
  if (next) url.searchParams.set("next", next);
  return NextResponse.redirect(url, 303);
}
```

- [ ] **Step 2:** Commit:

```bash
git add apps/web/app/api/auth/login
git commit -m "Add login Route Handler with form + JSON support"
```

### Task 1.6: Logout Route Handler

**Files:**
- Create: `apps/web/app/api/auth/logout/route.ts`

- [ ] **Step 1:** Implement:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { token } }); // idempotent
  }
  const res = NextResponse.redirect(new URL("/login", req.url), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
```

- [ ] **Step 2:** Commit:

```bash
git add apps/web/app/api/auth/logout
git commit -m "Add logout Route Handler"
```

### Task 1.7: `proxy.ts` — DB-backed session validation

**Files:**
- Create: `apps/web/proxy.ts`

- [ ] **Step 1:** Create `apps/web/proxy.ts` (Next.js 16 picks this up at the project root, replacing the old `middleware.ts`):

```typescript
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE, findValidSession } from "@/lib/auth";

const PUBLIC_PATHS = new Set<string>(["/login"]);
const PUBLIC_PREFIXES = ["/api/auth/", "/_next", "/favicon"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return loginRedirect(req);

  const session = await findValidSession(token);
  if (!session) return loginRedirect(req);

  // Sliding expiry: extend on use if >half TTL has elapsed.
  // Skipped for MVP simplicity; revisit if sessions feel sticky.

  const headers = new Headers(req.headers);
  headers.set("x-user-id", session.userId);
  return NextResponse.next({ request: { headers } });
}

function loginRedirect(req: NextRequest) {
  const url = new URL("/login", req.url);
  if (req.nextUrl.pathname !== "/") {
    url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  }
  return NextResponse.redirect(url, 303);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 2:** Commit:

```bash
git add apps/web/proxy.ts
git commit -m "Add proxy.ts with DB-backed session validation"
```

### Task 1.8: Login page (Server Component, HTML form)

**Files:**
- Create: `apps/web/app/login/page.tsx`

- [ ] **Step 1:** Implement:

```tsx
const ERROR_MESSAGES: Record<string, string> = {
  invalid: "That passcode didn't match. Try again.",
  missing: "Please enter your passcode.",
  "no-user": "No user is configured yet.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const message = error ? ERROR_MESSAGES[error] ?? "Login failed." : null;

  return (
    <main className="mx-auto mt-32 max-w-sm px-4">
      <h1 className="text-2xl font-semibold">Quotid</h1>
      <p className="mt-2 text-sm text-zinc-500">Enter your passcode to continue.</p>

      <form action="/api/auth/login" method="POST" className="mt-6 space-y-3">
        {next && <input type="hidden" name="next" value={next} />}
        <input
          name="passcode"
          type="password"
          autoFocus
          required
          autoComplete="current-password"
          className="w-full rounded border border-zinc-300 px-3 py-2"
          aria-label="Passcode"
        />
        <button
          type="submit"
          className="w-full rounded bg-black px-3 py-2 text-white hover:bg-zinc-800"
        >
          Sign in
        </button>
        {message && (
          <p role="alert" className="text-sm text-red-600">
            {message}
          </p>
        )}
      </form>
    </main>
  );
}
```

- [ ] **Step 2:** Commit:

```bash
git add apps/web/app/login
git commit -m "Add /login page (HTML form Server Component)"
```

### Task 1.9: TanStack Query provider scaffolding

**Files:**
- Create: `apps/web/lib/query-client.ts`
- Modify: `apps/web/app/layout.tsx`

- [ ] **Step 1:** Create `apps/web/lib/query-client.ts`:

```tsx
"use client";

import { QueryClient, QueryClientProvider, isServer } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { ReactNode, useState } from "react";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

let browserClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  if (!browserClient) browserClient = makeQueryClient();
  return browserClient;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => getQueryClient());
  return (
    <QueryClientProvider client={client}>
      {children}
      {process.env.NODE_ENV === "development" && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
```

- [ ] **Step 2:** Edit `apps/web/app/layout.tsx` to wrap the tree:

```tsx
import type { Metadata } from "next";
import "./globals.css";
import { QueryProvider } from "@/lib/query-client";

export const metadata: Metadata = {
  title: "Quotid",
  description: "Your nightly journal, by phone.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 3:** Commit:

```bash
git add apps/web/lib/query-client.ts apps/web/app/layout.tsx
git commit -m "Wire TanStack Query provider into root layout"
```

### Task 1.10: Journal-entries list endpoint and page (Server Component + hydration)

**Files:**
- Create: `apps/web/lib/codec.ts`
- Create: `apps/web/app/api/journal-entries/route.ts`
- Create: `apps/web/app/journal-entries/page.tsx`
- Create: `apps/web/app/journal-entries/journal-list.client.tsx`
- Modify: `apps/web/app/page.tsx` (root → redirect to `/journal-entries`)

> **Learning mode reminder for John:** the `<HydrationBoundary>` + `dehydrate()` plumbing in this task is the high-leverage TanStack pattern you said you wanted hands-on. Consider switching to Learning output style before writing the client component, or asking for a `TODO(human)` insertion at the `useQuery` call site.

- [ ] **Step 1:** Create `apps/web/lib/codec.ts` (camelCase ↔ snake_case at the HTTP/JSON boundary, per Zalando Option B):

```typescript
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function transformKeys(input: Json, fn: (k: string) => string): Json {
  if (Array.isArray(input)) return input.map((v) => transformKeys(v, fn));
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [fn(k), transformKeys(v as Json, fn)])
    );
  }
  return input;
}

export const toSnake = (v: Json) => transformKeys(v, camelToSnake);
export const toCamel = (v: Json) => transformKeys(v, snakeToCamel);
```

- [ ] **Step 2:** Create `apps/web/app/api/journal-entries/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toSnake } from "@/lib/codec";

export async function GET(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ type: "about:blank", status: 401 }, { status: 401 });

  const entries = await prisma.journalEntry.findMany({
    where: { userId },
    orderBy: { entryDate: "desc" },
    take: 50,
    select: { id: true, title: true, entryDate: true, createdAt: true },
  });

  return NextResponse.json({ items: toSnake(entries as never) });
}
```

- [ ] **Step 3:** Create `apps/web/app/journal-entries/page.tsx` (Server Component prefetches, dehydrates):

```tsx
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { prisma } from "@/lib/db";
import { currentUserId } from "@/lib/auth";
import { JournalList } from "./journal-list.client";

export default async function JournalEntriesPage() {
  const userId = await currentUserId();
  const queryClient = new QueryClient();

  await queryClient.prefetchQuery({
    queryKey: ["journal-entries"],
    queryFn: async () => {
      const entries = await prisma.journalEntry.findMany({
        where: { userId },
        orderBy: { entryDate: "desc" },
        take: 50,
        select: { id: true, title: true, entryDate: true, createdAt: true },
      });
      return entries.map((e) => ({
        id: e.id,
        title: e.title,
        entry_date: e.entryDate.toISOString(),
        created_at: e.createdAt.toISOString(),
      }));
    },
  });

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Journal</h1>
        <form action="/api/auth/logout" method="POST">
          <button className="text-sm text-zinc-500 hover:text-zinc-900">Sign out</button>
        </form>
      </header>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <JournalList />
      </HydrationBoundary>
    </main>
  );
}
```

- [ ] **Step 4:** Create `apps/web/app/journal-entries/journal-list.client.tsx`:

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";

type Entry = { id: string; title: string; entry_date: string; created_at: string };

async function fetchEntries(): Promise<Entry[]> {
  const res = await fetch("/api/journal-entries", { credentials: "include" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const json = await res.json();
  return json.items;
}

export function JournalList() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["journal-entries"],
    queryFn: fetchEntries,
  });

  if (isLoading) return <p className="mt-8 text-zinc-500">Loading…</p>;
  if (error) return <p className="mt-8 text-red-600">Couldn’t load entries.</p>;
  if (!data || data.length === 0) {
    return (
      <p className="mt-8 text-zinc-500">
        No entries yet. Your first journal will appear after your nightly call.
      </p>
    );
  }

  return (
    <ul className="mt-8 space-y-2">
      {data.map((entry) => (
        <li key={entry.id} className="rounded border border-zinc-200 p-3">
          <div className="text-sm text-zinc-500">
            {new Date(entry.entry_date).toLocaleDateString()}
          </div>
          <div className="font-medium">{entry.title}</div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5:** Replace `apps/web/app/page.tsx` with a redirect to `/journal-entries`:

```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/journal-entries");
}
```

- [ ] **Step 6:** Manual smoke test:

```bash
npm run dev --workspace=@quotid/web
```

In a private-window browser, visit `http://localhost:3000`.
Expected: redirected to `/login`, see the form. Submit your seeded passcode. Expected: 303 to `/journal-entries`, see the empty-state message and a Sign-out link.
Click Sign out. Expected: 303 back to `/login`.

- [ ] **Step 7:** Commit (three atomic commits, one per concern):

```bash
git add apps/web/lib/codec.ts
git commit -m "Add camelCase/snake_case codec for HTTP boundary"

git add apps/web/app/api/journal-entries
git commit -m "Add GET /api/journal-entries"

git add apps/web/app/journal-entries apps/web/app/page.tsx
git commit -m "Add /journal-entries page with TanStack hydration"
```

### Task 1.11: Login Route Handler integration test (load-bearing test #2)

**Files:**
- Create: `apps/web/__tests__/login-route.integration.test.ts`

This test hits the real Neon dev branch — it's an integration test, not a unit test. The point is to confirm that `verifyPasscode` + the rate limiter + Prisma all work together against a real DB.

- [ ] **Step 1:** Write the test:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST } from "../app/api/auth/login/route";
import { prisma } from "../lib/db";
import { hashPasscode } from "../lib/auth";

describe("POST /api/auth/login", () => {
  const PASSCODE = "test-passcode-12345";
  let userId: string;

  beforeAll(async () => {
    const hash = await hashPasscode(PASSCODE);
    const u = await prisma.user.upsert({
      where: { email: "test+login@example.com" },
      update: { passcodeHash: hash },
      create: {
        email: "test+login@example.com",
        phoneNumber: "+15555550199",
        timezone: "UTC",
        passcodeHash: hash,
      },
    });
    userId = u.id;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it("issues a session cookie on correct passcode", async () => {
    const form = new URLSearchParams({ passcode: PASSCODE });
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const res = await POST(req as never);
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/quotid_session=[^;]+;.*HttpOnly/);
    expect(res.headers.get("location")).toMatch(/\/journal-entries$/);
  });

  it("redirects to /login?error=invalid on wrong passcode", async () => {
    const form = new URLSearchParams({ passcode: "WRONG" });
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const res = await POST(req as never);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/\/login\?error=invalid/);
  });
});
```

- [ ] **Step 2:** Run it:

```bash
npm test --workspace=@quotid/web
```

Expected: both tests pass against the Neon dev branch. (Note: the login route's first call has a slow first-request cold start because of argon2 + Prisma; ~1–2 seconds is normal.)

- [ ] **Step 3:** Commit:

```bash
git add apps/web/__tests__/login-route.integration.test.ts
git commit -m "Add integration test for login Route Handler"
```

### Task 1.12: Update `nextjs.openapi.yaml` to reflect 303-redirect login

**Why:** the existing OpenAPI spec at `docs/architecture/api/nextjs.openapi.yaml` lines 76–98 documents `/auth/login` as `application/json` only with `204 + Set-Cookie` on success and `application/problem+json` on error. The implementation in Task 1.5 accepts both `application/x-www-form-urlencoded` and `application/json`, and responds with `303 + Set-Cookie + Location` on success or `303 → /login?error=…` on error. Spec must catch up before slice 1 can be considered locked.

**Files:**
- Modify: `docs/architecture/api/nextjs.openapi.yaml`

- [ ] **Step 1:** In the `/auth/login` `requestBody.content` block, add a sibling to `application/json`:

```yaml
requestBody:
  required: true
  content:
    application/json:
      schema: { $ref: '#/components/schemas/LoginRequest' }
    application/x-www-form-urlencoded:
      schema: { $ref: '#/components/schemas/LoginRequest' }
```

- [ ] **Step 2:** Replace the `responses` block with:

```yaml
responses:
  '303':
    description: |
      Login outcome. Browser follows the `Location` header.
      On success, the response carries `Set-Cookie: quotid_session=...` and
      Location is `/journal-entries` (or the `next` query param if provided).
      On failure (invalid passcode, missing field, no user, rate-limited),
      Location is `/login?error=<code>` where `<code>` is one of
      `invalid` | `missing` | `no-user` | `rate-limited`.
    headers:
      Set-Cookie:
        schema:
          type: string
          example: 'quotid_session=abc123...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000'
        description: Present only on success.
      Location:
        schema:
          type: string
          example: '/journal-entries'
```

(Removes `204`, `401`, `429` blocks — those response codes are no longer emitted by the implementation. The error semantics moved to the `?error=` query param.)

- [ ] **Step 3:** Commit:

```bash
git add docs/architecture/api/nextjs.openapi.yaml
git commit -m "Update auth login OpenAPI spec to 303-redirect form"
```

**Slice 1 done.** You can log in, see an empty journal list backed by TanStack Query hydration, and log out. Argon2 and the login flow are both proven by tests against the real DB. The OpenAPI spec is consistent with the implementation.

---
## Slice 2 — Temporal `create_call_session` activity (worker-first)

**Demoable outcome:** From a CLI, you can submit a workflow to a local Temporal dev server and watch the Python worker execute `create_call_session`, return a serializable `CreateCallSessionResult`, and complete. The full `JournalingWorkflow` exists as a stub that runs `create_call_session` and immediately returns. A pytest using `WorkflowEnvironment` verifies the activity in-process.

**Why this slice ships next:** `create_call_session` is the riskiest seam in the system — it touches Prisma-Python (an unfamiliar ORM port) plus the Temporal Python SDK plus our Pydantic data shapes. Proving it early de-risks every other Python-side activity in slice 4.

**Estimated effort:** 3–4 hours.

**File map:**

| Path | Responsibility |
|------|---------------|
| `workers/temporal-worker/pyproject.toml` | uv project, deps, scripts |
| `workers/temporal-worker/uv.lock` | Generated lockfile |
| `workers/temporal-worker/quotid_worker/__init__.py` | Package marker |
| `workers/temporal-worker/quotid_worker/config.py` | Env-driven config object |
| `workers/temporal-worker/quotid_worker/db.py` | prisma-client-python singleton |
| `workers/temporal-worker/quotid_worker/dto.py` | Pydantic models for activity I/O |
| `workers/temporal-worker/quotid_worker/activities.py` | Activity functions, with `create_call_session` first |
| `workers/temporal-worker/quotid_worker/workflows.py` | `JournalingWorkflow` skeleton |
| `workers/temporal-worker/quotid_worker/main.py` | Worker entrypoint |
| `workers/temporal-worker/schema.prisma` | Symlink or copy of root schema for the Python generator |
| `workers/temporal-worker/tests/test_create_call_session.py` | WorkflowEnvironment-based test |
| `workers/temporal-worker/scripts/trigger_workflow.py` | One-off CLI to start a workflow |

### Task 2.1: Bootstrap the uv project

**Files:**
- Create: `workers/temporal-worker/pyproject.toml`
- Create: `workers/temporal-worker/quotid_worker/__init__.py`

- [ ] **Step 1:** Initialize the project:

```bash
mkdir -p workers/temporal-worker/quotid_worker workers/temporal-worker/tests workers/temporal-worker/scripts
cd workers/temporal-worker
uv init --no-readme --no-pin-python --package
```

- [ ] **Step 2:** Replace `pyproject.toml` with:

```toml
[project]
name = "quotid-worker"
version = "0.1.0"
description = "Quotid Temporal worker"
requires-python = ">=3.12"
dependencies = [
  "temporalio>=1.7",
  "prisma>=0.15",
  "pydantic>=2.7",
  "python-dotenv>=1.0",
  "tenacity>=9.0",
]

[dependency-groups]
dev = [
  "pytest>=8.3",
  "pytest-asyncio>=0.23",
  "ruff>=0.6",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.uv]
package = true

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

- [ ] **Step 3:** Lock + install deps:

```bash
uv sync
```

- [ ] **Step 4:** Create the empty package marker:

```bash
touch quotid_worker/__init__.py
```

- [ ] **Step 5:** Commit (from repo root):

```bash
cd ../..
git add workers/temporal-worker/pyproject.toml workers/temporal-worker/uv.lock workers/temporal-worker/quotid_worker/__init__.py
git commit -m "Bootstrap workers/temporal-worker uv project"
```

### Task 2.2: prisma-client-python wired against the shared schema

**Files:**
- Create: `workers/temporal-worker/schema.prisma` (symlink to root)
- Create: `workers/temporal-worker/quotid_worker/db.py`
- Modify: `prisma/schema.prisma` (add Python client generator)

- [ ] **Step 1:** Add a second `generator` block to `prisma/schema.prisma` (place right after the existing `generator client` block):

```prisma
generator client_python {
  provider             = "prisma-client-py"
  recursive_type_depth = 5
  interface            = "asyncio"
}
```

No explicit `output =`. The default puts the generated client into the venv's `prisma` package, importable as `from prisma import Prisma` from any process whose venv has `prisma>=0.15` installed (i.e., the worker's uv venv).

- [ ] **Step 2:** Create `workers/temporal-worker/schema.prisma` as a symlink:

```bash
cd workers/temporal-worker
ln -s ../../prisma/schema.prisma schema.prisma
cd ../..
```

- [ ] **Step 3:** From the worker directory, generate the Python client:

```bash
cd workers/temporal-worker
uv run prisma generate
cd ../..
```

Expected: the generator emits Python types into the venv's `prisma` package and prints a success message. The generator may print warnings about the recursive type depth — fine.

- [ ] **Step 4:** Create `workers/temporal-worker/quotid_worker/db.py`:

```python
"""Prisma client singleton for the worker.

The Python client is async-first; we connect lazily from the worker entrypoint
and disconnect on shutdown. Activity functions just import `prisma`.
"""

from prisma import Prisma

prisma = Prisma()


async def connect() -> None:
    if not prisma.is_connected():
        await prisma.connect()


async def disconnect() -> None:
    if prisma.is_connected():
        await prisma.disconnect()
```

- [ ] **Step 5:** Commit (two commits):

```bash
git add prisma/schema.prisma
git commit -m "Add prisma-client-python generator block"

git add workers/temporal-worker/schema.prisma workers/temporal-worker/quotid_worker/db.py
git commit -m "Add Prisma client singleton for the worker"
```

### Task 2.3: Pydantic DTOs for activity I/O

**Files:**
- Create: `workers/temporal-worker/quotid_worker/dto.py`

- [ ] **Step 1:** Implement the data shapes the workflow and activities exchange. Names mirror the Step 3 design doc:

```python
"""Pydantic DTOs exchanged between workflow and activities.

Snake_case field names (matches Postgres + Zalando boundary convention).
Temporal serializes via Pydantic v2 by default with the right data converter
(set in `main.py`). All fields are JSON-safe.
"""

from datetime import datetime
from enum import Enum
from pydantic import BaseModel, Field


# ─── Workflow input ──────────────────────────────────────────────────────

class JournalingWorkflowInput(BaseModel):
    """Top-level argument to JournalingWorkflow.run. Matches
    docs/architecture/temporal-workflow.md §3.1."""

    user_id: str
    call_schedule_id: str | None = None  # None for manual triggers
    scheduled_for: datetime              # UTC instant — drives entry_date


# ─── Activity inputs / outputs ───────────────────────────────────────────

class CreateCallSessionInput(BaseModel):
    user_id: str
    scheduled_for: datetime
    workflow_id: str  # pinned to CallSession.temporal_workflow_id


class CreateCallSessionResult(BaseModel):
    call_session_id: str
    phone_number: str  # E.164
    user_timezone: str


class InitiateCallInput(BaseModel):
    call_session_id: str
    workflow_id: str
    activity_id: str  # deterministic: "await-call"
    to_phone: str


class InitiateCallResult(BaseModel):
    twilio_call_sid: str


class CallOutcomeStatus(str, Enum):
    COMPLETED = "COMPLETED"
    NO_ANSWER = "NO_ANSWER"
    FAILED = "FAILED"


class CallOutcome(BaseModel):
    """Returned by `await_call`. Captures everything `summarize` and the
    journal-write side need."""

    status: CallOutcomeStatus
    call_session_id: str
    twilio_call_sid: str
    started_at: datetime | None = None
    ended_at: datetime | None = None
    duration_seconds: int | None = None
    recording_url: str | None = None
    transcript_text: str | None = None       # present iff COMPLETED
    transcript_segments: list[dict] | None = Field(default=None)
    failure_reason: str | None = None        # present iff NO_ANSWER / FAILED


class SummarizeInput(BaseModel):
    transcript_text: str
    user_timezone: str
    entry_date: str  # ISO date "2026-04-24"


class SummarizeResult(BaseModel):
    title: str
    body: str


class StoreEntryInput(BaseModel):
    user_id: str
    call_session_id: str
    outcome: CallOutcome
    summary: SummarizeResult | None = None  # None for NO_ANSWER / FAILED branches
```

- [ ] **Step 2:** Commit:

```bash
git add workers/temporal-worker/quotid_worker/dto.py
git commit -m "Add Pydantic DTOs for activity I/O"
```

### Task 2.4: `create_call_session` activity

**Files:**
- Create: `workers/temporal-worker/quotid_worker/config.py`
- Create: `workers/temporal-worker/quotid_worker/activities.py`

- [ ] **Step 1:** Create `quotid_worker/config.py`:

```python
"""Env-driven config. Loaded once at worker startup."""

import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.environ.get("DOTENV_PATH", "../../.env"))


@dataclass(frozen=True)
class Config:
    temporal_address: str = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
    temporal_namespace: str = os.environ.get("TEMPORAL_NAMESPACE", "default")
    bot_public_url: str = os.environ["BOT_PUBLIC_URL"]
    bot_internal_url: str = os.environ.get("BOT_INTERNAL_URL", "http://localhost:8000")
    task_queue: str = "quotid-main"


CONFIG = Config()
```

(`bot_public_url` is used to build the TwiML URL Twilio fetches.
`bot_internal_url` is used by `initiate_call` to POST to the bot's `/calls`
endpoint — that route is intentionally Caddy-blocked in production per
decision #14, so the worker MUST hit the bot via Docker's internal network.)

- [ ] **Step 2:** Create `quotid_worker/activities.py`:

```python
"""Temporal activities for Quotid.

Each activity is an `async def` decorated with `@activity.defn`. Activities
have access to a process-global Prisma client (see `db.py`).

Names match docs/architecture/temporal-workflow.md §3 exactly so the design
doc and the code never drift.
"""

from temporalio import activity

from .db import prisma
from .dto import CreateCallSessionInput, CreateCallSessionResult


@activity.defn
async def create_call_session(inp: CreateCallSessionInput) -> CreateCallSessionResult:
    """Read the user, create a CallSession row, and return phone+timezone for
    the rest of the workflow. Also pins CallSession.temporal_workflow_id."""

    user = await prisma.user.find_unique(where={"id": inp.user_id})
    if user is None:
        raise ValueError(f"User {inp.user_id} not found")

    cs = await prisma.callsession.create(
        data={
            "userId": user.id,
            "scheduledFor": inp.scheduled_for,
            "status": "PENDING",
            "temporalWorkflowId": inp.workflow_id,
        }
    )

    return CreateCallSessionResult(
        call_session_id=cs.id,
        phone_number=user.phoneNumber,
        user_timezone=user.timezone,
    )
```

(Why pass `workflow_id` in the input rather than reading `activity.info().workflow_id` inside the activity? Because the *workflow* knows its ID and can construct the input deterministically — this keeps the activity body trivially testable without a real `WorkflowEnvironment`.)

- [ ] **Step 3:** Commit (two commits):

```bash
git add workers/temporal-worker/quotid_worker/config.py
git commit -m "Add worker config loader"

git add workers/temporal-worker/quotid_worker/activities.py
git commit -m "Add create_call_session activity"
```

### Task 2.5: Workflow skeleton (`JournalingWorkflow`)

**Files:**
- Create: `workers/temporal-worker/quotid_worker/workflows.py`

The full workflow is the 5-step state machine in `docs/architecture/temporal-workflow.md` §2. For slice 2 we ship a stub that calls `create_call_session` and returns the resulting `call_session_id`. Slice 4 fills in the rest (`initiate_call → await_call → summarize → store_entry`, plus the NO_ANSWER/FAILED branch).

- [ ] **Step 1:** Implement:

```python
"""JournalingWorkflow — slice-2 skeleton.

Calls `create_call_session` and returns the resulting call_session_id as a
stand-in for the final outcome. Slice 4 replaces the body with the full
state machine.
"""

from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from .activities import create_call_session
    from .dto import (
        CreateCallSessionInput,
        JournalingWorkflowInput,
    )


@workflow.defn(name="JournalingWorkflow")
class JournalingWorkflow:
    @workflow.run
    async def run(self, inp: JournalingWorkflowInput) -> str:
        result = await workflow.execute_activity(
            create_call_session,
            CreateCallSessionInput(
                user_id=inp.user_id,
                scheduled_for=inp.scheduled_for,
                workflow_id=workflow.info().workflow_id,
            ),
            start_to_close_timeout=timedelta(seconds=10),
        )
        return result.call_session_id
```

- [ ] **Step 2:** Commit:

```bash
git add workers/temporal-worker/quotid_worker/workflows.py
git commit -m "Add JournalingWorkflow skeleton calling create_call_session"
```

### Task 2.6: Worker entrypoint

**Files:**
- Create: `workers/temporal-worker/quotid_worker/main.py`

- [ ] **Step 1:** Implement:

```python
"""Worker entrypoint. Runs `python -m quotid_worker.main`."""

import asyncio
import logging

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from .config import CONFIG
from .db import connect, disconnect
from .activities import create_call_session
from .workflows import JournalingWorkflow


async def amain() -> None:
    logging.basicConfig(level=logging.INFO)

    await connect()

    client = await Client.connect(
        CONFIG.temporal_address,
        namespace=CONFIG.temporal_namespace,
        data_converter=pydantic_data_converter,
    )

    worker = Worker(
        client,
        task_queue=CONFIG.task_queue,
        workflows=[JournalingWorkflow],
        activities=[create_call_session],
    )

    try:
        await worker.run()
    finally:
        await disconnect()


if __name__ == "__main__":
    asyncio.run(amain())
```

- [ ] **Step 2:** Add a script entry to `pyproject.toml` under `[project]`:

```toml
[project.scripts]
quotid-worker = "quotid_worker.main:amain"
```

- [ ] **Step 3:** Commit:

```bash
git add workers/temporal-worker/quotid_worker/main.py workers/temporal-worker/pyproject.toml
git commit -m "Add worker entrypoint and console script"
```

### Task 2.7: Smoke-test against `temporal server start-dev`

**Files:** none

- [ ] **Step 1:** In one terminal, start the Temporal dev server:

```bash
brew install temporal  # macOS; on Ubuntu use the install script from temporal.io
temporal server start-dev --ui-port 8233
```

UI will be at `http://localhost:8233`.

- [ ] **Step 2:** In a second terminal, run the worker:

```bash
cd workers/temporal-worker
uv run python -m quotid_worker.main
```

Expected: `INFO Worker started`. No errors.

- [ ] **Step 3:** Create `workers/temporal-worker/scripts/find_user.py` (small helper so we don't have to wedge async Python into a bash one-liner):

```python
"""Print the first User row's id. Used by the trigger helper."""

import asyncio
from prisma import Prisma


async def main() -> None:
    p = Prisma()
    await p.connect()
    user = await p.user.find_first()
    if user is None:
        raise SystemExit("No User row found. Did the seed run?")
    print(user.id)
    await p.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 4:** Create `workers/temporal-worker/scripts/trigger_workflow.py`:

```python
"""One-off helper to kick off a JournalingWorkflow.

Usage: uv run python scripts/trigger_workflow.py <user_id>
"""

import asyncio
import sys
from datetime import datetime, timezone

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter

from quotid_worker.config import CONFIG
from quotid_worker.dto import JournalingWorkflowInput


async def main(user_id: str) -> None:
    now = datetime.now(timezone.utc)
    client = await Client.connect(
        CONFIG.temporal_address,
        namespace=CONFIG.temporal_namespace,
        data_converter=pydantic_data_converter,
    )
    workflow_id = f"journal-{user_id}-manual-{now.strftime('%Y%m%dT%H%M%S')}"
    handle = await client.start_workflow(
        "JournalingWorkflow",
        JournalingWorkflowInput(
            user_id=user_id,
            scheduled_for=now,
        ),
        id=workflow_id,
        task_queue=CONFIG.task_queue,
    )
    print(f"Started: {handle.id}")
    result = await handle.result()
    print(f"Result: {result}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
```

- [ ] **Step 5:** From a third terminal, fetch the seeded user ID and trigger the workflow:

```bash
cd workers/temporal-worker
USER_ID=$(uv run python scripts/find_user.py)
uv run python scripts/trigger_workflow.py "$USER_ID"
```

Expected: workflow runs, prints a `call_session_id`, the Temporal UI shows the workflow as `Completed`, and a new row exists in `call_sessions` (Neon SQL editor: `SELECT * FROM call_sessions ORDER BY created_at DESC LIMIT 1;`).

- [ ] **Step 6:** Commit the helpers (two commits):

```bash
git add workers/temporal-worker/scripts/find_user.py
git commit -m "Add find_user helper script"

git add workers/temporal-worker/scripts/trigger_workflow.py
git commit -m "Add manual trigger script for JournalingWorkflow"
```

### Task 2.8: WorkflowEnvironment-based test (load-bearing test #3)

**Files:**
- Create: `workers/temporal-worker/tests/__init__.py`
- Create: `workers/temporal-worker/tests/conftest.py`
- Create: `workers/temporal-worker/tests/test_create_call_session.py`

This test runs an in-process Temporal `WorkflowEnvironment`, registers a stub `create_call_session`, and asserts the workflow returns the expected `call_session_id`. No Neon, no real Temporal server.

- [ ] **Step 1:** Create the `__init__.py`:

```bash
touch workers/temporal-worker/tests/__init__.py
```

- [ ] **Step 2:** Create `tests/conftest.py`:

```python
import pytest_asyncio
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment


@pytest_asyncio.fixture
async def env():
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter,
    ) as e:
        yield e
```

(Modern Temporal Python SDK accepts `data_converter` as a kwarg on
`start_time_skipping`. No private-attribute mutation needed.)

- [ ] **Step 3:** Write the failing test at `tests/test_create_call_session.py`:

```python
import uuid
from datetime import datetime, timezone

from temporalio import activity
from temporalio.worker import Worker

from quotid_worker.workflows import JournalingWorkflow
from quotid_worker.dto import (
    CreateCallSessionInput,
    CreateCallSessionResult,
    JournalingWorkflowInput,
)


@activity.defn(name="create_call_session")
async def stub_create_call_session(inp: CreateCallSessionInput) -> CreateCallSessionResult:
    return CreateCallSessionResult(
        call_session_id="cs_test",
        phone_number="+15555550100",
        user_timezone="UTC",
    )


async def test_workflow_invokes_create_call_session(env):
    client = env.client
    async with Worker(
        client,
        task_queue="test-queue",
        workflows=[JournalingWorkflow],
        activities=[stub_create_call_session],
    ):
        result = await client.execute_workflow(
            "JournalingWorkflow",
            JournalingWorkflowInput(
                user_id="user_123",
                scheduled_for=datetime(2026, 4, 25, 21, 0, tzinfo=timezone.utc),
            ),
            id=f"test-{uuid.uuid4()}",
            task_queue="test-queue",
        )
        assert result == "cs_test"
```

- [ ] **Step 4:** Run:

```bash
cd workers/temporal-worker
uv run pytest -v
```

Expected: 1 passed.

- [ ] **Step 5:** Commit:

```bash
git add workers/temporal-worker/tests
git commit -m "Add WorkflowEnvironment test for create_call_session"
```

**Slice 2 done.** A Python worker runs against a local Temporal server, executes `create_call_session`, persists a `CallSession` row to Neon, and returns a typed Pydantic DTO. An in-process test proves the workflow→activity wiring works without external dependencies.

---
## Slice 3 — Manual call trigger UI

**Demoable outcome:** On `/journal-entries` there's a "Trigger nightly call" button. Clicking it submits a Server Action that connects to Temporal, starts a `JournalingWorkflow` for the current user, and returns the workflow ID. The user sees a toast or status line confirming "Call started — workflow `journal-cuid-manual-1234`." A new row appears in `call_sessions` and the Temporal UI shows the workflow completing (still the slice-2 stub — it just runs `create_call_session` and exits).

**Estimated effort:** 1.5–2 hours.

**File map:**

| Path | Responsibility |
|------|---------------|
| `apps/web/lib/temporal-client.ts` | Singleton TS client to Temporal |
| `apps/web/app/journal-entries/actions.ts` | `triggerCall` Server Action |
| `apps/web/app/journal-entries/trigger-call-button.client.tsx` | Client component with form action |
| `apps/web/app/journal-entries/page.tsx` | Renders the button below the header |

### Task 3.1: TypeScript Temporal client singleton

**Files:**
- Create: `apps/web/lib/temporal-client.ts`

- [ ] **Step 1:** Install the TS SDK:

```bash
npm install --workspace=@quotid/web @temporalio/client
```

- [ ] **Step 2:** Implement `apps/web/lib/temporal-client.ts`:

```typescript
import "server-only";
import { Connection, Client } from "@temporalio/client";

declare global {
  // eslint-disable-next-line no-var
  var __temporalClient: Client | undefined;
}

export async function getTemporalClient(): Promise<Client> {
  if (global.__temporalClient) return global.__temporalClient;

  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });

  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  });

  if (process.env.NODE_ENV !== "production") global.__temporalClient = client;
  return client;
}

export const TASK_QUEUE = "quotid-main";
```

- [ ] **Step 3:** Commit:

```bash
git add apps/web/lib/temporal-client.ts apps/web/package.json package-lock.json
git commit -m "Add Temporal TypeScript client singleton"
```

### Task 3.2: `triggerCall` Server Action

**Files:**
- Create: `apps/web/app/journal-entries/actions.ts`

- [ ] **Step 1:** Implement:

```typescript
"use server";

import { revalidatePath } from "next/cache";
import { currentUserId } from "@/lib/auth";
import { getTemporalClient, TASK_QUEUE } from "@/lib/temporal-client";

export type TriggerCallResult =
  | { ok: true; workflowId: string }
  | { ok: false; error: string };

export async function triggerCall(): Promise<TriggerCallResult> {
  const userId = await currentUserId();
  const client = await getTemporalClient();

  // Manual workflow ID format from the Step 3 design doc:
  //   journal-{user_id}-manual-{YYYYMMDDTHHMMSS}
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const workflowId = `journal-${userId}-manual-${ts}`;

  try {
    await client.workflow.start("JournalingWorkflow", {
      workflowId,
      taskQueue: TASK_QUEUE,
      // JournalingWorkflowInput shape — matches the Pydantic model in
      // workers/temporal-worker/quotid_worker/dto.py. The Pydantic data
      // converter on both sides handles the JSON ↔ model conversion.
      args: [
        {
          user_id: userId,
          call_schedule_id: null,        // null for manual triggers
          scheduled_for: new Date().toISOString(),
        },
      ],
    });
    revalidatePath("/journal-entries");
    return { ok: true, workflowId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown error" };
  }
}
```

(Server Actions are camelCase by Zalando Option B — that's why this is `triggerCall`, not `trigger_call`. The *contents* of the workflow input use snake_case because they cross the Temporal boundary into the Python worker.)

- [ ] **Step 2:** Commit:

```bash
git add apps/web/app/journal-entries/actions.ts
git commit -m "Add triggerCall Server Action"
```

### Task 3.3: Trigger button (Client Component)

**Files:**
- Create: `apps/web/app/journal-entries/trigger-call-button.client.tsx`

- [ ] **Step 1:** Implement:

```tsx
"use client";

import { useState, useTransition } from "react";
import { triggerCall, TriggerCallResult } from "./actions";

export function TriggerCallButton() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<TriggerCallResult | null>(null);

  return (
    <div className="mt-4">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await triggerCall();
            setResult(r);
          })
        }
        className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50 hover:bg-zinc-800"
      >
        {pending ? "Starting…" : "Trigger nightly call"}
      </button>
      {result?.ok && (
        <p className="mt-2 text-sm text-green-700">
          Call started — workflow <code className="font-mono">{result.workflowId}</code>
        </p>
      )}
      {result && !result.ok && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {result.error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2:** Commit:

```bash
git add apps/web/app/journal-entries/trigger-call-button.client.tsx
git commit -m "Add trigger-call button component"
```

### Task 3.4: Wire the button into the journal-entries page

**Files:**
- Modify: `apps/web/app/journal-entries/page.tsx`

- [ ] **Step 1:** Edit `page.tsx` to render `<TriggerCallButton />` between the header and the hydration boundary. Replace the existing `return` in `JournalEntriesPage` with:

```tsx
import { TriggerCallButton } from "./trigger-call-button.client";

// ... inside JournalEntriesPage:
return (
  <main className="mx-auto max-w-2xl px-4 py-12">
    <header className="flex items-center justify-between">
      <h1 className="text-2xl font-semibold">Journal</h1>
      <form action="/api/auth/logout" method="POST">
        <button className="text-sm text-zinc-500 hover:text-zinc-900">Sign out</button>
      </form>
    </header>
    <TriggerCallButton />
    <HydrationBoundary state={dehydrate(queryClient)}>
      <JournalList />
    </HydrationBoundary>
  </main>
);
```

- [ ] **Step 2:** Commit:

```bash
git add apps/web/app/journal-entries/page.tsx
git commit -m "Render TriggerCallButton on journal entries page"
```

### Task 3.5: End-to-end smoke test

- [ ] **Step 1:** With the Temporal dev server still running and the worker still running (from slice 2), start Next.js:

```bash
npm run dev --workspace=@quotid/web
```

- [ ] **Step 2:** Log in, click "Trigger nightly call." Expected:
  - Button shows "Starting…" briefly, then "Call started — workflow journal-…-manual-…"
  - Temporal UI at `localhost:8233` shows a new completed `JournalingWorkflow` execution
  - Neon SQL editor: `SELECT * FROM call_sessions ORDER BY created_at DESC LIMIT 1` shows a fresh row with `status='PENDING'` and the right `temporal_workflow_id`

- [ ] **Step 3:** No commit needed; this step is verification only.

**Slice 3 done.** The web UI starts real Temporal workflows that execute on the Python worker. Half the system is wired together. Slices 4 + 5 fill in the actual call.

---
## Slice 4 — Full call flow + journal entry visible (the demo)

**Demoable outcome:** Click "Trigger nightly call" on `/journal-entries`. Your phone rings within ~5 seconds. You answer; the bot greets you and asks about your day. You speak; the bot responds; you have a brief multi-turn conversation. You hang up. Within ~10 seconds a new entry appears in `/journal-entries` titled with a Storyworthy-style summary; clicking it shows the full body and the realtime transcript.

**Conversation termination:** the user hangs up. Twilio fires `statusCallback` with `CallStatus=completed`; that webhook ignores `completed` (Pipecat is the authoritative completer for the happy path, decision #8). On Pipecat's side, the WSS close triggers async activity completion of `await_call` with the assembled `CallOutcome`. The 20-minute `start_to_close_timeout` is the ceiling.

**Estimated effort:** 6–10 hours. Highest-risk slice.

**File map:**

| Path | Responsibility |
|------|---------------|
| `apps/pipecat-bot/pyproject.toml` | uv project for the bot |
| `apps/pipecat-bot/quotid_bot/__init__.py` | Package marker |
| `apps/pipecat-bot/quotid_bot/config.py` | Env-driven config |
| `apps/pipecat-bot/quotid_bot/server.py` | FastAPI app + REST endpoints |
| `apps/pipecat-bot/quotid_bot/correlation.py` | In-process registry: `call_sid → (wf_id, act_id, cs_id)` |
| `apps/pipecat-bot/quotid_bot/pipeline.py` | Pipecat pipeline + transport setup |
| `apps/pipecat-bot/quotid_bot/transcript_accumulator.py` | Custom FrameProcessor for transcripts |
| `apps/pipecat-bot/quotid_bot/twilio_signature.py` | Verifies `X-Twilio-Signature` |
| `apps/pipecat-bot/quotid_bot/temporal_completion.py` | Calls `complete_async` on `await_call` |
| `apps/pipecat-bot/quotid_bot/system_prompt.py` | Storyworthy prompt template |
| `workers/temporal-worker/quotid_worker/activities.py` | Add `initiate_call`, `await_call`, `handle_missed_call`, `summarize`, `store_entry` |
| `workers/temporal-worker/quotid_worker/workflows.py` | Full `JournalingWorkflow` |
| `workers/temporal-worker/quotid_worker/main.py` | Register all activities |
| `apps/web/app/api/webhooks/twilio/call-status/route.ts` | Watchdog Route Handler |
| `apps/web/app/journal-entries/[id]/page.tsx` | Entry detail view |
| `apps/web/app/api/journal-entries/[id]/route.ts` | Detail endpoint |
| `cloudflared/config.yml` | Tunnel config (gitignored or templated) |

### Task 4.1: Bootstrap `apps/pipecat-bot`

**Files:**
- Create: `apps/pipecat-bot/pyproject.toml`
- Create: `apps/pipecat-bot/quotid_bot/__init__.py`

- [ ] **Step 1:** Initialize:

```bash
mkdir -p apps/pipecat-bot/quotid_bot apps/pipecat-bot/tests
cd apps/pipecat-bot
uv init --no-readme --no-pin-python --package
```

- [ ] **Step 2:** Replace `pyproject.toml`:

```toml
[project]
name = "quotid-bot"
version = "0.1.0"
description = "Quotid Pipecat bot server"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.30",
  "pipecat-ai[silero,smart-turn,daily,deepgram,cartesia,openai]>=0.0.50",
  "pipecat-ai-flows>=0.0.10",
  "twilio>=9.3",
  "temporalio>=1.7",
  "pydantic>=2.7",
  "python-dotenv>=1.0",
  "loguru>=0.7",
  "websockets>=13.0",
]

[dependency-groups]
dev = [
  "pytest>=8.3",
  "pytest-asyncio>=0.23",
  "httpx>=0.27",
]

[project.scripts]
quotid-bot = "quotid_bot.server:run"

[tool.pytest.ini_options]
asyncio_mode = "auto"
```

- [ ] **Step 3:** Lock + install:

```bash
uv sync
```

(Pipecat's optional deps pull large dependencies — Silero VAD, smart-turn model. First sync may take a few minutes.)

- [ ] **Step 4:** Commit (from repo root):

```bash
cd ../..
git add apps/pipecat-bot/pyproject.toml apps/pipecat-bot/uv.lock apps/pipecat-bot/quotid_bot/__init__.py
git commit -m "Bootstrap apps/pipecat-bot uv project"
```

### Task 4.2: Bot config + correlation registry

**Files:**
- Create: `apps/pipecat-bot/quotid_bot/config.py`
- Create: `apps/pipecat-bot/quotid_bot/correlation.py`

- [ ] **Step 1:** Implement `config.py`:

```python
import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.environ.get("DOTENV_PATH", "../../.env"))


@dataclass(frozen=True)
class Config:
    twilio_account_sid: str = os.environ["TWILIO_ACCOUNT_SID"]
    twilio_auth_token: str = os.environ["TWILIO_AUTH_TOKEN"]
    twilio_phone_number: str = os.environ["TWILIO_PHONE_NUMBER"]
    deepgram_api_key: str = os.environ["DEEPGRAM_API_KEY"]
    openrouter_api_key: str = os.environ["OPENROUTER_API_KEY"]
    cartesia_api_key: str = os.environ["CARTESIA_API_KEY"]
    cartesia_voice_id: str = os.environ["CARTESIA_VOICE_ID"]
    bot_public_url: str = os.environ["BOT_PUBLIC_URL"]   # Twilio reaches /twiml + /stream here
    app_public_url: str = os.environ["APP_PUBLIC_URL"]   # Twilio reaches statusCallback here
    temporal_address: str = os.environ.get("TEMPORAL_ADDRESS", "localhost:7233")
    temporal_namespace: str = os.environ.get("TEMPORAL_NAMESPACE", "default")


CONFIG = Config()
```

- [ ] **Step 2:** Implement `correlation.py` — the in-process registry that connects Twilio's `CallSid` (only known after dial) to the workflow ID and activity ID we registered at `initiate_call` time. **Single uvicorn worker is required.**

```python
"""In-process correlation registry.

Maps `call_sid → (workflow_id, activity_id, call_session_id)` so the WSS
handler knows which Temporal async-activity to complete on call end.

REQUIRES uvicorn --workers=1. Multi-worker deployment would split the
registry across processes and break correlation.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class CallCorrelation:
    workflow_id: str
    activity_id: str
    call_session_id: str


_REGISTRY: dict[str, CallCorrelation] = {}


def register(call_sid: str, corr: CallCorrelation) -> None:
    _REGISTRY[call_sid] = corr


def lookup(call_sid: str) -> CallCorrelation | None:
    return _REGISTRY.get(call_sid)


def remove(call_sid: str) -> None:
    _REGISTRY.pop(call_sid, None)
```

- [ ] **Step 3:** Commit (two commits):

```bash
git add apps/pipecat-bot/quotid_bot/config.py
git commit -m "Add bot config loader"

git add apps/pipecat-bot/quotid_bot/correlation.py
git commit -m "Add in-process call correlation registry"
```

### Task 4.3: Twilio signature verifier

**Files:**
- Create: `apps/pipecat-bot/quotid_bot/twilio_signature.py`

- [ ] **Step 1:** Implement:

```python
"""Verify X-Twilio-Signature on inbound HTTP/WSS requests.

Twilio's RequestValidator is the canonical implementation; it just wraps
HMAC-SHA1 over the URL + sorted POST params (or empty for GETs/WSS upgrades).
"""

from twilio.request_validator import RequestValidator
from .config import CONFIG

_validator = RequestValidator(CONFIG.twilio_auth_token)


def verify(url: str, params: dict[str, str] | str, signature: str | None) -> bool:
    if not signature:
        return False
    return _validator.validate(url, params, signature)
```

- [ ] **Step 2:** Commit:

```bash
git add apps/pipecat-bot/quotid_bot/twilio_signature.py
git commit -m "Add Twilio request signature verifier"
```

### Task 4.4: Storyworthy system prompt

**Files:**
- Create: `apps/pipecat-bot/quotid_bot/system_prompt.py`

The prompt is short for MVP — a fuller Storyworthy template can replace it without code changes.

- [ ] **Step 1:** Implement:

```python
"""The in-call system prompt. Storyworthy-lite for MVP.

The prompt's job is to elicit a brief story about today, not a comprehensive
diary. It should:
  - greet the user by name
  - ask one open-ended question about the day
  - ask one follow-up that invites a moment ("what did that feel like?")
  - close gracefully when the user signals they're done
"""

OPENING_LINE = (
    "Hey John, it's your nightly check-in. "
    "Tell me about something that happened today — "
    "small or big, doesn't matter."
)


SYSTEM_PROMPT = """\
You are a warm, brief journaling companion on a phone call with John at the
end of his day. You are NOT a therapist, NOT a chatbot, and NOT giving
advice — you are helping him surface one short story from today.

Your goal: elicit ONE concrete moment from today and one follow-up about how
it felt or what he made of it. Stay grounded in his words; don't invent.

Style:
- Speak like a friend on the phone, not a customer-service bot.
- Sentences are short; questions are simpler than statements.
- Never list options. One question at a time.
- If he says "that's all" or "I'm done," wrap up with a single sentence
  ("Got it — sleep well") and stop talking.

You will be transcribed in real time. Transcripts can have errors; if a word
is unclear, ask him to repeat once, then move on.

Begin with the OPENING_LINE injected into the conversation as your first
message; don't repeat it.
"""
```

- [ ] **Step 2:** Commit:

```bash
git add apps/pipecat-bot/quotid_bot/system_prompt.py
git commit -m "Add Storyworthy-lite in-call system prompt"
```

### Task 4.5: TranscriptAccumulator FrameProcessor

**Files:**
- Create: `apps/pipecat-bot/quotid_bot/transcript_accumulator.py`

Custom Pipecat `FrameProcessor` per `pipecat-pipeline.md` §9. Captures user transcripts from `TranscriptionFrame.is_final == True` (with frame timestamps), reads assistant turns from `LLMContext.messages` at call-end, fetches `recording_url` from Twilio, and emits a `CallOutcome`.

- [ ] **Step 1:** Implement:

```python
"""TranscriptAccumulator — passive observer that records user transcripts
and assembles the post-call CallOutcome.

User-side: capture final TranscriptionFrames with their audio-level
timestamps (frame.start_ms / frame.end_ms), don't synthesize from
wall clock.

Assistant-side: read LLMContext.messages at call-end time. No audio
timestamps for assistant turns; ordering is preserved from message order.

Recording URL: fetched from Twilio at build_outcome() time so the
canonical-transcript activity (Step 6) has it later.
"""

from dataclasses import dataclass
from typing import Any

from pipecat.frames.frames import Frame, TranscriptionFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass
class Segment:
    speaker: str  # "user" | "assistant"
    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    confidence: float | None = None


class TranscriptAccumulator(FrameProcessor):
    """Pass-through processor; siphons final user TranscriptionFrames."""

    def __init__(self, context: LLMContext) -> None:
        super().__init__()
        self._segments: list[Segment] = []
        self._context = context

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            # Only finalized turns enter the transcript. Non-final
            # TranscriptionFrames (Deepgram interim results) feed VAD/SmartTurn
            # but don't get persisted.
            is_final = getattr(frame, "is_final", True)  # interim flag varies by version
            if is_final and frame.text:
                self._segments.append(
                    Segment(
                        speaker="user",
                        text=frame.text,
                        start_ms=getattr(frame, "start_ms", None),
                        end_ms=getattr(frame, "end_ms", None),
                        confidence=getattr(frame, "confidence", None),
                    )
                )

        await self.push_frame(frame, direction)

    async def build_outcome(
        self,
        *,
        call_session_id: str,
        twilio_call_sid: str,
        twilio_client: Any,
    ) -> dict:
        """Merge user segments + assistant turns; fetch recording from Twilio.

        Returns a dict shaped like CallOutcome (the worker-side Pydantic model
        in workers/temporal-worker/quotid_worker/dto.py). The Pydantic data
        converter validates on the worker side.
        """
        import asyncio

        assistant_segments = self._assistant_segments_from_context()
        all_segments = [s.__dict__ for s in self._segments + assistant_segments]
        transcript_text = " ".join(
            m.get("content", "")
            for m in self._context.messages
            if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
        )

        # Twilio recording lookup is a network call — avoid blocking event loop.
        try:
            recordings = await asyncio.to_thread(
                twilio_client.recordings.list, call_sid=twilio_call_sid, limit=1
            )
            recording_url = recordings[0].uri if recordings else None
        except Exception:
            recording_url = None  # not fatal; canonical activity will skip on None

        return {
            "status": "COMPLETED",
            "call_session_id": call_session_id,
            "twilio_call_sid": twilio_call_sid,
            "transcript_text": transcript_text,
            "transcript_segments": all_segments,
            "recording_url": recording_url,
        }

    def _assistant_segments_from_context(self) -> list[Segment]:
        out: list[Segment] = []
        for m in self._context.messages:
            if m.get("role") != "assistant":
                continue
            content = m.get("content", "")
            if isinstance(content, list):
                content = " ".join(
                    c.get("text", "") for c in content if isinstance(c, dict)
                )
            if not content:
                continue
            out.append(Segment(speaker="assistant", text=content))
        return out
```

- [ ] **Step 2:** Commit:

```bash
git add apps/pipecat-bot/quotid_bot/transcript_accumulator.py
git commit -m "Add TranscriptAccumulator FrameProcessor"
```

### Task 4.6: Pipecat pipeline factory

**Files:**
- Create: `apps/pipecat-bot/quotid_bot/pipeline.py`

- [ ] **Step 1:** Implement the pipeline. Topology + imports + VAD/turn-analyzer placement match `pipecat-pipeline.md` §4 verbatim:

```python
"""Per-call Pipecat pipeline construction.

Topology and module paths follow docs/architecture/pipecat-pipeline.md §4
exactly. Don't 'simplify' without updating the design doc — VAD lives on
the user aggregator (not the transport) so SmartTurn governs end-of-turn
without double-paying for VAD silence detection.
"""

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.frames.frames import TextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai import OpenAILLMService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .config import CONFIG
from .system_prompt import OPENING_LINE, SYSTEM_PROMPT
from .transcript_accumulator import TranscriptAccumulator


class QuotidCartesiaTTSService(CartesiaTTSService):
    """Empty subclass — present so a future Modal-hosted TTS slots in as a
    sibling under Pipecat's TTSService base. Decision #7 / #11."""


def build_pipeline(
    websocket,
    stream_sid: str,
    call_sid: str,
) -> tuple[PipelineTask, TranscriptAccumulator, LLMContext]:
    """Construct the per-call pipeline. Returns the runnable task plus the
    accumulator and context the caller needs to build the post-call outcome."""

    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        account_sid=CONFIG.twilio_account_sid,
        auth_token=CONFIG.twilio_auth_token,
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    stt = DeepgramSTTService(api_key=CONFIG.deepgram_api_key)

    llm = OpenAILLMService(
        api_key=CONFIG.openrouter_api_key,
        base_url="https://openrouter.ai/api/v1",
        model="anthropic/claude-haiku-4-5",
    )

    tts = QuotidCartesiaTTSService(
        api_key=CONFIG.cartesia_api_key,
        voice_id=CONFIG.cartesia_voice_id,
    )

    context = LLMContext(messages=[{"role": "system", "content": SYSTEM_PROMPT}])
    accumulator = TranscriptAccumulator(context)

    # VAD + SmartTurn live on the USER aggregator, not the transport.
    # See pipecat-pipeline.md §6: short stop_secs because SmartTurn does the
    # real end-of-turn determination; long VAD windows would stack on top.
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(
                params=VADParams(stop_secs=0.2, start_secs=0.2, confidence=0.7)
            ),
            user_turn_strategies=UserTurnStrategies(
                stop=[
                    TurnAnalyzerUserTurnStopStrategy(
                        turn_analyzer=LocalSmartTurnAnalyzerV3(),
                    )
                ],
            ),
        ),
    )

    pipeline = Pipeline([
        transport.input(),
        stt,
        accumulator,
        user_aggregator,
        llm,
        tts,
        transport.output(),
        assistant_aggregator,
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,    # decision #11: μ-law 8 kHz on Twilio leg
            audio_out_sample_rate=8000,
            allow_interruptions=True,
            enable_metrics=True,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def kick_off(_t, _client):
        # Bot speaks first. Sending a TextFrame routes through TTS → transport
        # output → assistant_aggregator, which captures it into LLMContext.
        # We do NOT call context.add_message manually — the assistant
        # aggregator is the canonical writer.
        await task.queue_frames([TextFrame(OPENING_LINE)])

    return task, accumulator, context
```

(`PipelineRunner` is invoked by the caller; the factory just wires the graph.)

- [ ] **Step 2:** Commit:

```bash
git add apps/pipecat-bot/quotid_bot/pipeline.py
git commit -m "Add Pipecat pipeline factory"
```

### Task 4.7: Async-completion bridge to Temporal

**Files:**
- Create: `apps/pipecat-bot/quotid_bot/temporal_completion.py`

- [ ] **Step 1:** Implement:

```python
"""Completes the `await_call` async activity from the bot side.

The workflow uses `activity_id="await-call"` deterministically so we can
construct the handle from `(workflow_id, activity_id)` without persisting
a task token. The watchdog (Twilio statusCallback Route Handler) does the
same. Race-safety: if the other side completes first, we swallow
AsyncActivityNotFoundError — that's the success case (Pipecat happy path
got there first).
"""

from typing import Any

from loguru import logger
from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.exceptions import ApplicationError
from temporalio.service import RPCError

from .config import CONFIG


_client: Client | None = None


async def get_client() -> Client:
    global _client
    if _client is None:
        _client = await Client.connect(
            CONFIG.temporal_address,
            namespace=CONFIG.temporal_namespace,
            data_converter=pydantic_data_converter,
        )
    return _client


async def complete_await_call(workflow_id: str, payload: dict[str, Any]) -> None:
    client = await get_client()
    handle = client.get_async_activity_handle(
        workflow_id=workflow_id,
        activity_id="await-call",
    )
    try:
        await handle.complete(payload)
    except RPCError as e:
        # Most common: NotFound — the watchdog beat us. Fine.
        logger.warning(f"complete_await_call: {workflow_id} already finalized: {e}")


async def fail_await_call(workflow_id: str, reason: str) -> None:
    client = await get_client()
    handle = client.get_async_activity_handle(
        workflow_id=workflow_id,
        activity_id="await-call",
    )
    try:
        await handle.fail(ApplicationError(reason, type="BotError"))
    except RPCError as e:
        logger.warning(f"fail_await_call: {workflow_id} already finalized: {e}")
```

- [ ] **Step 2:** Commit:

```bash
git add apps/pipecat-bot/quotid_bot/temporal_completion.py
git commit -m "Add async activity completion bridge for Temporal"
```

### Task 4.8: FastAPI server with all three endpoints

**Files:**
- Create: `apps/pipecat-bot/quotid_bot/server.py`

- [ ] **Step 1:** Implement:

```python
"""FastAPI server for Quotid Pipecat bot.

Three endpoints:
  POST /calls                — internal (Docker network only); creates Twilio call
  GET  /calls/{sid}/twiml    — public; Twilio fetches TwiML
  WSS  /calls/{sid}/stream   — public; Twilio Media Streams audio
"""

import asyncio
import json
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Header, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from loguru import logger
from pipecat.pipeline.runner import PipelineRunner
from pydantic import BaseModel
from twilio.rest import Client as TwilioClient

from .config import CONFIG
from .correlation import CallCorrelation, lookup, register, remove
from .pipeline import build_pipeline
from .temporal_completion import complete_await_call, fail_await_call
from .twilio_signature import verify

twilio = TwilioClient(CONFIG.twilio_account_sid, CONFIG.twilio_auth_token)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield


app = FastAPI(lifespan=lifespan)


# ─── POST /calls ───────────────────────────────────────────────────────────

class CreateCallRequest(BaseModel):
    workflow_id: str
    activity_id: str
    call_session_id: str
    phone_number: str  # E.164


class CreateCallResponse(BaseModel):
    twilio_call_sid: str


@app.post("/calls", response_model=CreateCallResponse, status_code=202)
async def create_call(req: CreateCallRequest) -> CreateCallResponse:
    twiml_url = f"{CONFIG.bot_public_url}/calls/{req.call_session_id}/twiml"
    # The status-callback target is the Next.js APP, not the bot.
    # APP_PUBLIC_URL is set explicitly in .env (no string-substitution magic).
    status_callback_url = f"{CONFIG.app_public_url}/api/webhooks/twilio/call-status"

    call = await asyncio.to_thread(
        twilio.calls.create,
        to=req.phone_number,
        from_=CONFIG.twilio_phone_number,
        url=twiml_url,
        status_callback=status_callback_url,
        status_callback_event=["initiated", "ringing", "answered", "completed"],
    )

    register(
        call.sid,
        CallCorrelation(
            workflow_id=req.workflow_id,
            activity_id=req.activity_id,
            call_session_id=req.call_session_id,
        ),
    )
    logger.info(f"Created Twilio call {call.sid} for workflow {req.workflow_id}")
    return CreateCallResponse(twilio_call_sid=call.sid)


# ─── GET /calls/{call_session_id}/twiml ─────────────────────────────────────

@app.api_route("/calls/{call_session_id}/twiml", methods=["GET", "POST"])
async def twiml(
    call_session_id: str,
    request: Request,
    x_twilio_signature: str | None = Header(default=None),
) -> PlainTextResponse:
    body = await request.body()
    form = dict((await request.form()) if request.method == "POST" else {})
    full_url = f"{CONFIG.bot_public_url}/calls/{call_session_id}/twiml"
    if not verify(full_url, form, x_twilio_signature):
        logger.warning(f"Invalid Twilio signature on /twiml for {call_session_id}")
        raise HTTPException(status_code=403)

    stream_url = (
        f"{CONFIG.bot_public_url.replace('https://', 'wss://').replace('http://', 'ws://')}"
        f"/calls/{call_session_id}/stream"
    )
    twiml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Response>'
        f'<Connect><Stream url="{stream_url}"/></Connect>'
        '</Response>'
    )
    return PlainTextResponse(content=twiml, media_type="application/xml")


# ─── WSS /calls/{call_session_id}/stream ────────────────────────────────────

@app.websocket("/calls/{call_session_id}/stream")
async def stream(websocket: WebSocket, call_session_id: str) -> None:
    # Twilio sends two control frames first: "connected" and "start"; the
    # latter contains streamSid + callSid. Read them before building the pipeline.
    await websocket.accept(subprotocol="audio.twilio.com")

    start_msg = None
    async for raw in websocket.iter_text():
        msg = json.loads(raw)
        if msg.get("event") == "start":
            start_msg = msg
            break

    if start_msg is None:
        await websocket.close(code=1011)
        return

    stream_sid = start_msg["start"]["streamSid"]
    call_sid = start_msg["start"]["callSid"]

    corr = lookup(call_sid)
    if corr is None:
        logger.error(f"No correlation for callSid {call_sid}; closing")
        await websocket.close(code=1011)
        return

    task, accumulator, _context = build_pipeline(websocket, stream_sid, call_sid)

    runner = PipelineRunner(handle_sigint=False)  # FastAPI owns signals

    try:
        await runner.run(task)
    except WebSocketDisconnect:
        logger.info(f"WSS disconnected for callSid {call_sid}")
    except Exception:
        logger.exception(f"Pipeline error for callSid {call_sid}")
        await fail_await_call(corr.workflow_id, "pipeline_error")
        remove(call_sid)
        return

    # Build CallOutcome (the accumulator does the heavy lifting; it pulls
    # assistant turns from the LLM context and the recording_url from Twilio).
    payload = await accumulator.build_outcome(
        call_session_id=corr.call_session_id,
        twilio_call_sid=call_sid,
        twilio_client=twilio,
    )
    await complete_await_call(corr.workflow_id, payload)
    remove(call_sid)


def run() -> None:
    """Console-script entry point."""
    import uvicorn
    uvicorn.run("quotid_bot.server:app", host="0.0.0.0", port=8000, workers=1, log_level="info")
```

- [ ] **Step 2:** Smoke-test imports:

```bash
cd apps/pipecat-bot
uv run python -c "from quotid_bot.server import app; print('ok')"
```

Expected: prints `ok` with no errors.

- [ ] **Step 3:** Commit:

```bash
cd ../..
git add apps/pipecat-bot/quotid_bot/server.py
git commit -m "Add FastAPI server with /calls + /twiml + /stream"
```

### Task 4.9: Twilio status-callback Route Handler (watchdog)

**Files:**
- Create: `apps/web/app/api/webhooks/twilio/call-status/route.ts`

This is the Next.js side of decision #8. Only abnormal statuses (`no-answer`, `failed`, `busy`, `canceled`) forward to Temporal — normal `completed` is left to Pipecat as the authoritative happy-path completer.

- [ ] **Step 1:** Install Twilio SDK on the Next side:

```bash
npm install --workspace=@quotid/web twilio
```

- [ ] **Step 2:** Verify the actual TS SDK method name for async-activity completion. Different `@temporalio/client` versions have used `client.activity.async(...)` and `client.activity.getAsyncCompletionHandle(...)`. Run:

```bash
node --input-type=module -e "import('@temporalio/client').then(m => { const c = new m.Client(); console.log(Object.keys(c.activity)); })"
```

(`new Client()` with no args is fine for introspection — no connection is made until you call a method.)

Expected output: an array of method names. Use whichever of `async` or `getAsyncCompletionHandle` appears, and update the implementation in Step 3 accordingly. The plan below uses `getAsyncCompletionHandle`.

- [ ] **Step 3:** Implement `apps/web/app/api/webhooks/twilio/call-status/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getTemporalClient } from "@/lib/temporal-client";
import { prisma } from "@/lib/db";
import twilio from "twilio";

const ABNORMAL: ReadonlySet<string> = new Set(["no-answer", "failed", "busy", "canceled"]);

const STATUS_MAP: Record<string, "NO_ANSWER" | "FAILED"> = {
  "no-answer": "NO_ANSWER",
  failed: "FAILED",
  busy: "NO_ANSWER",
  canceled: "FAILED",
};

export async function POST(req: NextRequest) {
  const sig = req.headers.get("x-twilio-signature") ?? "";
  const url = new URL(req.url);
  const formText = await req.text();
  const params = new URLSearchParams(formText);
  const paramsObj = Object.fromEntries(params.entries());

  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN!,
    sig,
    url.toString(),
    paramsObj
  );
  if (!valid) return new NextResponse("Forbidden", { status: 403 });

  const callSid = params.get("CallSid");
  const callStatus = params.get("CallStatus");
  if (!callSid || !callStatus) return new NextResponse(null, { status: 204 });

  // Pipecat is the authoritative completer for the normal hangup path.
  if (!ABNORMAL.has(callStatus)) return new NextResponse(null, { status: 204 });

  const cs = await prisma.callSession.findUnique({
    where: { twilioCallSid: callSid },
    select: { temporalWorkflowId: true, id: true },
  });
  if (!cs) return new NextResponse(null, { status: 204 });

  const client = await getTemporalClient();
  const handle = client.activity.getAsyncCompletionHandle({
    workflowId: cs.temporalWorkflowId,
    activityId: "await-call",
  });
  try {
    await handle.complete({
      status: STATUS_MAP[callStatus] ?? "FAILED",
      call_session_id: cs.id,
      twilio_call_sid: callSid,
      failure_reason: `twilio:${callStatus}`,
      // recording_url omitted intentionally — abnormal calls rarely have one,
      // and we must NOT clobber a value that Pipecat may have already written.
    });
  } catch {
    // Activity may already be complete (race with Pipecat) — that's the
    // success case; swallow.
  }

  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 4:** Commit (two commits):

```bash
git add apps/web/package.json package-lock.json
git commit -m "Add twilio SDK to apps/web"

git add apps/web/app/api/webhooks
git commit -m "Add Twilio status-callback watchdog Route Handler"
```

### Task 4.10: Worker — fill in the rest of the activities + workflow

**Files:**
- Modify: `workers/temporal-worker/quotid_worker/activities.py`
- Modify: `workers/temporal-worker/quotid_worker/workflows.py`
- Modify: `workers/temporal-worker/quotid_worker/main.py`

- [ ] **Step 1:** Append to `quotid_worker/activities.py`. Activity names match `temporal-workflow.md` §3 exactly.

```python
import json
import os
from datetime import date

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from .config import CONFIG
from .db import prisma
from .dto import (
    CallOutcome,
    CallOutcomeStatus,
    InitiateCallInput,
    InitiateCallResult,
    StoreEntryInput,
    SummarizeInput,
    SummarizeResult,
)


@activity.defn
async def initiate_call(inp: InitiateCallInput) -> InitiateCallResult:
    """Asks the Pipecat bot to place the call. Returns the Twilio CallSid.

    Hits the bot's INTERNAL URL — the public URL is Caddy-blocked for
    POST /calls per decision #14.
    """
    payload = {
        "workflow_id": inp.workflow_id,
        "activity_id": inp.activity_id,  # "await-call"
        "call_session_id": inp.call_session_id,
        "phone_number": inp.to_phone,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{CONFIG.bot_internal_url}/calls", json=payload)
        # Twilio 4xx — non-retryable. Anything else, raise normally so Temporal
        # honors the workflow's retry policy.
        if r.status_code in (400, 401, 403, 404):
            raise ApplicationError(
                f"bot rejected /calls: {r.status_code} {r.text}",
                type="TwilioClientError",
                non_retryable=True,
            )
        r.raise_for_status()
        sid = r.json()["twilio_call_sid"]

    await prisma.callsession.update(
        where={"id": inp.call_session_id},
        data={"twilioCallSid": sid, "status": "DIALING"},
    )
    return InitiateCallResult(twilio_call_sid=sid)


@activity.defn
async def await_call(call_session_id: str) -> CallOutcome:
    """ASYNC-COMPLETED. Calling raise_complete_async() WITHOUT raising it
    silently completes the activity with None — see the warning in
    temporal-workflow.md §3.1.
    """
    raise activity.raise_complete_async()


@activity.defn
async def handle_missed_call(inp: StoreEntryInput) -> None:
    """For NO_ANSWER / FAILED. Records the failure on CallSession, never
    creates a JournalEntry — design doc §9 open-question #2 settled MVP-side
    in favor of NO entry for missed calls (avoids cluttering the journal)."""
    status_map = {
        CallOutcomeStatus.NO_ANSWER: "NO_ANSWER",
        CallOutcomeStatus.FAILED: "FAILED",
    }
    await prisma.callsession.update(
        where={"id": inp.call_session_id},
        data={
            "status": status_map.get(inp.outcome.status, "FAILED"),
            "endedAt": inp.outcome.ended_at,
            "failureReason": inp.outcome.failure_reason,
        },
    )


@activity.defn
async def summarize(inp: SummarizeInput) -> SummarizeResult:
    """Post-call LLM summary using OpenRouter + Sonnet 4.6."""
    api_key = os.environ["OPENROUTER_API_KEY"]
    prompt = (
        f"You are summarizing a brief journaling phone call from "
        f"{inp.entry_date} (timezone: {inp.user_timezone}) into a "
        f"Storyworthy-style entry. Output JSON with two fields: title "
        f"(short, evocative, ≤8 words) and body (2–4 sentences, "
        f"first-person, in the user's voice). No markdown, no preamble.\n\n"
        f"Transcript:\n{inp.transcript_text}"
    )

    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": "anthropic/claude-sonnet-4-6",
                "messages": [{"role": "user", "content": prompt}],
                "response_format": {"type": "json_object"},
            },
        )
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        raise ApplicationError(f"summary not JSON: {e}", non_retryable=False) from e

    return SummarizeResult(
        title=parsed.get("title", "Untitled"),
        body=parsed.get("body", ""),
    )


@activity.defn
async def store_entry(inp: StoreEntryInput) -> str:
    """Persist transcript + journal entry; finalize CallSession status.

    Only writes recordingUrl when the outcome carries one — otherwise we'd
    clobber a value that may have been set by a prior happy-path completion.
    """
    cs_data: dict = {
        "status": "COMPLETED",
        "twilioCallSid": inp.outcome.twilio_call_sid,
        "startedAt": inp.outcome.started_at,
        "endedAt": inp.outcome.ended_at,
        "durationSeconds": inp.outcome.duration_seconds,
    }
    if inp.outcome.recording_url is not None:
        cs_data["recordingUrl"] = inp.outcome.recording_url

    await prisma.callsession.update(where={"id": inp.call_session_id}, data=cs_data)

    if inp.outcome.transcript_text:
        await prisma.transcript.upsert(
            where={
                "callSessionId_kind": {
                    "callSessionId": inp.call_session_id,
                    "kind": "REALTIME",
                }
            },
            data={
                "create": {
                    "callSessionId": inp.call_session_id,
                    "kind": "REALTIME",
                    "provider": "DEEPGRAM",
                    "text": inp.outcome.transcript_text,
                    "segments": inp.outcome.transcript_segments or [],
                    "wordCount": len(inp.outcome.transcript_text.split()),
                },
                "update": {
                    "text": inp.outcome.transcript_text,
                    "segments": inp.outcome.transcript_segments or [],
                    "wordCount": len(inp.outcome.transcript_text.split()),
                },
            },
        )

    if inp.summary is None:
        return ""  # Defensive — workflow should not call store_entry without a summary.

    entry = await prisma.journalentry.create(
        data={
            "userId": inp.user_id,
            "callSessionId": inp.call_session_id,
            "title": inp.summary.title,
            "body": inp.summary.body,
            "generatedBody": inp.summary.body,
            "isEdited": False,
            "entryDate": date.today(),
        }
    )
    return entry.id
```

- [ ] **Step 2:** Replace `workflows.py` with the full state machine. Matches `temporal-workflow.md` §3.2 verbatim (modulo Pydantic-vs-dataclass DTO syntax).

```python
"""Full JournalingWorkflow — matches docs/architecture/temporal-workflow.md §3.2."""

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from .activities import (
        create_call_session,
        initiate_call,
        await_call,
        handle_missed_call,
        summarize,
        store_entry,
    )
    from .dto import (
        CallOutcome,
        CallOutcomeStatus,
        CreateCallSessionInput,
        InitiateCallInput,
        JournalingWorkflowInput,
        StoreEntryInput,
        SummarizeInput,
        SummarizeResult,
    )


_DEFAULT_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=30),
    maximum_attempts=3,
)

_INITIATE_CALL_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=2),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=10),
    maximum_attempts=3,
    non_retryable_error_types=["TwilioClientError"],
)

_SUMMARIZE_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    backoff_coefficient=1.0,
    maximum_interval=timedelta(seconds=10),
    maximum_attempts=2,
)


@workflow.defn(name="JournalingWorkflow")
class JournalingWorkflow:
    @workflow.run
    async def run(self, inp: JournalingWorkflowInput) -> str | None:
        wf_id = workflow.info().workflow_id

        session = await workflow.execute_activity(
            create_call_session,
            CreateCallSessionInput(
                user_id=inp.user_id,
                scheduled_for=inp.scheduled_for,
                workflow_id=wf_id,
            ),
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=_DEFAULT_RETRY,
        )

        await workflow.execute_activity(
            initiate_call,
            InitiateCallInput(
                call_session_id=session.call_session_id,
                workflow_id=wf_id,
                activity_id="await-call",
                to_phone=session.phone_number,
            ),
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=_INITIATE_CALL_RETRY,
        )

        try:
            outcome: CallOutcome = await workflow.execute_activity(
                await_call,
                session.call_session_id,
                activity_id="await-call",
                start_to_close_timeout=timedelta(minutes=20),
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
        except ActivityError as e:
            outcome = CallOutcome(
                status=CallOutcomeStatus.FAILED,
                call_session_id=session.call_session_id,
                twilio_call_sid="",
                failure_reason=f"await_call backstop: {type(e).__name__}",
            )

        if outcome.status != CallOutcomeStatus.COMPLETED:
            await workflow.execute_activity(
                handle_missed_call,
                StoreEntryInput(
                    user_id=inp.user_id,
                    call_session_id=session.call_session_id,
                    outcome=outcome,
                    summary=None,
                ),
                start_to_close_timeout=timedelta(seconds=10),
                retry_policy=_DEFAULT_RETRY,
            )
            return None

        summary: SummarizeResult = await workflow.execute_activity(
            summarize,
            SummarizeInput(
                transcript_text=outcome.transcript_text or "",
                user_timezone="UTC",  # TODO: thread user_timezone through CallOutcome
                entry_date=inp.scheduled_for.date().isoformat(),
            ),
            start_to_close_timeout=timedelta(minutes=2),
            retry_policy=_SUMMARIZE_RETRY,
        )

        return await workflow.execute_activity(
            store_entry,
            StoreEntryInput(
                user_id=inp.user_id,
                call_session_id=session.call_session_id,
                outcome=outcome,
                summary=summary,
            ),
            start_to_close_timeout=timedelta(seconds=15),
            retry_policy=_DEFAULT_RETRY,
        )
```

- [ ] **Step 3:** Update `main.py` to register all activities. Replace the `Worker(...)` construction with:

```python
worker = Worker(
    client,
    task_queue=CONFIG.task_queue,
    workflows=[JournalingWorkflow],
    activities=[
        create_call_session,
        initiate_call,
        await_call,
        handle_missed_call,
        summarize,
        store_entry,
    ],
)
```

And update the imports at the top:

```python
from .activities import (
    create_call_session,
    initiate_call,
    await_call,
    handle_missed_call,
    summarize,
    store_entry,
)
```

- [ ] **Step 4:** Commit atomically — **one activity per commit**, per the global atomic-commit rule. The cleanest workflow: write each activity's body into `activities.py` in sequence, staging+committing the file between activities. The full code block in Step 1 is the *final* state; decompose your edits in five passes.

  Order to commit (one commit each, in this order):

  1. `Add initiate_call activity`
  2. `Add await_call activity (raise_complete_async)`
  3. `Add handle_missed_call activity`
  4. `Add summarize activity`
  5. `Add store_entry activity`

  Then two more commits for the workflow + worker registration:

```bash
git add workers/temporal-worker/quotid_worker/workflows.py
git commit -m "Implement full JournalingWorkflow state machine"

git add workers/temporal-worker/quotid_worker/main.py
git commit -m "Register all activities on the worker"
```

### Task 4.11: Journal entry detail view

**Files:**
- Create: `apps/web/app/journal-entries/[id]/page.tsx`
- Create: `apps/web/app/api/journal-entries/[id]/route.ts`

- [ ] **Step 1:** Create the detail Route Handler at `apps/web/app/api/journal-entries/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toSnake } from "@/lib/codec";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = req.headers.get("x-user-id");
  if (!userId) return NextResponse.json({ status: 401 }, { status: 401 });
  const { id } = await params;

  const entry = await prisma.journalEntry.findFirst({
    where: { id, userId },
    include: {
      callSession: {
        include: { transcripts: { where: { kind: "REALTIME" } } },
      },
    },
  });

  if (!entry) return NextResponse.json({ status: 404 }, { status: 404 });

  const transcript = entry.callSession?.transcripts[0]?.text ?? null;
  return NextResponse.json(toSnake({
    id: entry.id,
    title: entry.title,
    body: entry.body,
    entryDate: entry.entryDate.toISOString(),
    transcriptText: transcript,
  } as never));
}
```

- [ ] **Step 2:** Create the detail page at `apps/web/app/journal-entries/[id]/page.tsx` (Server Component, no TanStack — read-only detail):

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUserId } from "@/lib/auth";

export default async function EntryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await currentUserId();
  const { id } = await params;

  const entry = await prisma.journalEntry.findFirst({
    where: { id, userId },
    include: {
      callSession: {
        include: { transcripts: { where: { kind: "REALTIME" } } },
      },
    },
  });

  if (!entry) notFound();

  const transcript = entry.callSession?.transcripts[0]?.text ?? null;

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link href="/journal-entries" className="text-sm text-zinc-500 hover:text-zinc-900">
        ← Back to journal
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">{entry.title}</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {entry.entryDate.toLocaleDateString(undefined, { dateStyle: "long" })}
      </p>
      <article className="mt-6 whitespace-pre-line text-base leading-7">{entry.body}</article>
      {transcript && (
        <details className="mt-8">
          <summary className="cursor-pointer text-sm text-zinc-500">View transcript</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded bg-zinc-50 p-3 text-xs">
            {transcript}
          </pre>
        </details>
      )}
    </main>
  );
}
```

- [ ] **Step 3:** Update `apps/web/app/journal-entries/journal-list.client.tsx` to wrap each entry in a `<Link href={`/journal-entries/${id}`}>`:

```tsx
import Link from "next/link";

// ... inside the .map:
<li key={entry.id} className="rounded border border-zinc-200 hover:bg-zinc-50">
  <Link href={`/journal-entries/${entry.id}`} className="block p-3">
    <div className="text-sm text-zinc-500">{new Date(entry.entry_date).toLocaleDateString()}</div>
    <div className="font-medium">{entry.title}</div>
  </Link>
</li>
```

- [ ] **Step 4:** Commit (three commits):

```bash
git add apps/web/app/api/journal-entries/[id]
git commit -m "Add GET /api/journal-entries/{id}"

git add apps/web/app/journal-entries/[id]
git commit -m "Add journal entry detail page"

git add apps/web/app/journal-entries/journal-list.client.tsx
git commit -m "Link list items to entry detail pages"
```

### Task 4.12: cloudflared tunnel setup for slice 4 dev

**Files:**
- Create: `cloudflared/config.yml.example`

- [ ] **Step 1:** Create the tunnel:

```bash
cloudflared tunnel create quotid-bot
# Outputs a tunnel UUID; capture it.
```

- [ ] **Step 2:** Route a stable subdomain to it (replace `bot.YOUR_DOMAIN.com` with the subdomain you want):

```bash
cloudflared tunnel route dns quotid-bot bot.YOUR_DOMAIN.com
cloudflared tunnel route dns quotid-bot app.YOUR_DOMAIN.com
```

- [ ] **Step 3:** Create `cloudflared/config.yml.example` (committed; the real `cloudflared/config.yml` with the credentials path stays in `~/.cloudflared/`):

```yaml
tunnel: quotid-bot
credentials-file: /home/john/.cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: bot.YOUR_DOMAIN.com
    service: http://localhost:8000
  - hostname: app.YOUR_DOMAIN.com
    service: http://localhost:3000
  - service: http_status:404
```

- [ ] **Step 4:** Run the tunnel in a dedicated terminal:

```bash
cloudflared tunnel run quotid-bot
```

Expected: `INF Connection registered ...`

- [ ] **Step 5:** Set in `.env`:

```
BOT_PUBLIC_URL=https://bot.YOUR_DOMAIN.com
BOT_INTERNAL_URL=http://localhost:8000
APP_PUBLIC_URL=https://app.YOUR_DOMAIN.com
```

(`BOT_INTERNAL_URL` stays at `http://localhost:8000` in dev because the worker, the bot, and Next.js all run on the same loopback. Only in production does it change to `http://bot:8000` — wired up in slice 5's compose.yaml.)

Restart the bot, worker, and Next.js so they pick up the change.

- [ ] **Step 6:** Configure your Twilio number's voice URL to `https://bot.YOUR_DOMAIN.com/calls/PLACEHOLDER/twiml` — actually, leave it empty. Twilio uses the `url` parameter from `calls.create`, not the number's static voice URL, when we initiate outbound calls. The number-level config matters only for inbound; not in scope.

- [ ] **Step 7:** Commit:

```bash
git add cloudflared/config.yml.example
git commit -m "Add cloudflared tunnel config template"
```

### Task 4.13: First real end-to-end call

This is the demo verification step. No tests, no commits — just confirm everything works.

- [ ] **Step 1:** With these processes running in separate terminals:
  - `temporal server start-dev --ui-port 8233`
  - `cloudflared tunnel run quotid-bot`
  - `cd apps/pipecat-bot && uv run python -m quotid_bot.server` (or `quotid-bot` console script)
  - `cd workers/temporal-worker && uv run python -m quotid_worker.main`
  - `npm run dev --workspace=@quotid/web`

- [ ] **Step 2:** Log into the web UI. Click "Trigger nightly call." Your phone rings within 5 seconds.

- [ ] **Step 3:** Answer. Verify:
  - Bot greets you with the OPENING_LINE
  - You can speak; bot responds within 2 seconds (latency target 1.0–1.5 s; ~2 s acceptable in dev)
  - You have a 2–3 turn conversation
  - Hang up
  - Within 10 seconds, refresh `/journal-entries`. New entry appears.
  - Click the entry; you see a Storyworthy-style summary and the transcript expandable section.

- [ ] **Step 4:** If anything fails:
  - Check Temporal UI at `localhost:8233` for the workflow's failure details
  - Check the bot's terminal for Pipecat exception traces
  - Check Neon's `call_sessions` row for the call's status; check `transcripts` and `journal_entries`

**Slice 4 done.** The demo runs end-to-end on local infrastructure. Slice 5 is just deploying it.

---
## Slice 5 — Deploy to Oracle Cloud

**Demoable outcome:** SSH to your Oracle A1 instance, run `docker compose up -d`, and within ~2 minutes the entire stack (Caddy, Next.js, Pipecat bot, Temporal worker, Temporal dev server) is running. Your domain serves the app over HTTPS via Caddy's auto-issued Let's Encrypt cert. You log in from your phone, click "Trigger nightly call," and the demo flow works exactly as it did locally.

**Estimated effort:** 3–4 hours, dominated by network/DNS/secrets configuration.

**Trade-off note for `temporal`:** for the demo we run `temporal server start-dev` inside the compose. That's an ephemeral mode — workflows don't survive a restart. Acceptable for a portfolio artifact; replace with a proper Temporal cluster (Postgres-backed, separate compose stack) only if a recurring nightly schedule is added.

**File map:**

| Path | Responsibility |
|------|---------------|
| `apps/web/Dockerfile` | Multi-stage Next.js standalone build |
| `apps/pipecat-bot/Dockerfile` | Python image with uv |
| `workers/temporal-worker/Dockerfile` | Same shape as bot |
| `compose.yaml` | All services, networks, volumes |
| `Caddyfile` | Reverse proxy + TLS |
| `.dockerignore` | Per-app + root-level |
| `scripts/deploy.sh` | One-shot deploy/update from local checkout |

### Task 5.1: Next.js standalone Docker build

**Files:**
- Create: `apps/web/Dockerfile`
- Create: `apps/web/.dockerignore`
- Modify: `apps/web/next.config.ts` (add `output: "standalone"`)

- [ ] **Step 1:** Edit `apps/web/next.config.ts`:

```typescript
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
```

The `outputFileTracingRoot` is critical in a monorepo — without it, the standalone build won't include the root `node_modules`. `__dirname` isn't defined natively in ESM (which `next.config.ts` is in Next 16); compute it from `import.meta.url`.

- [ ] **Step 2:** Create `apps/web/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build --workspace=@quotid/web

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup -S nextjs && adduser -S nextjs -G nextjs
COPY --from=builder --chown=nextjs:nextjs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nextjs /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
```

- [ ] **Step 3:** Create `apps/web/.dockerignore`:

```
node_modules
.next
.turbo
.env*
__tests__
*.test.ts
```

- [ ] **Step 4:** Build locally to verify:

```bash
docker build -f apps/web/Dockerfile -t quotid-web:dev .
```

Expected: image builds without errors. Quick run-test:

```bash
docker run --rm -p 3000:3000 --env-file .env quotid-web:dev
```

Visit `localhost:3000`; should redirect to `/login` (won't fully work without a Temporal connection, but the Next.js process should start).

- [ ] **Step 5:** Commit:

```bash
git add apps/web/Dockerfile apps/web/.dockerignore apps/web/next.config.ts
git commit -m "Add Dockerfile for apps/web with standalone output"
```

### Task 5.2: Pipecat bot Docker build

**Files:**
- Create: `apps/pipecat-bot/Dockerfile`
- Create: `apps/pipecat-bot/.dockerignore`

- [ ] **Step 1:** Create `apps/pipecat-bot/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

FROM python:3.12-slim AS base
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# System deps for audio (libsndfile etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY apps/pipecat-bot/pyproject.toml apps/pipecat-bot/uv.lock /app/
RUN uv sync --frozen --no-dev

COPY apps/pipecat-bot/quotid_bot /app/quotid_bot

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "quotid_bot.server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
```

- [ ] **Step 2:** Create `apps/pipecat-bot/.dockerignore`:

```
.venv
__pycache__
*.pyc
tests
.env*
```

- [ ] **Step 3:** Build locally:

```bash
docker build -f apps/pipecat-bot/Dockerfile -t quotid-bot:dev .
```

Expected: image builds. (The first build is slow because of Pipecat's deps; subsequent builds use BuildKit cache.)

- [ ] **Step 4:** Commit:

```bash
git add apps/pipecat-bot/Dockerfile apps/pipecat-bot/.dockerignore
git commit -m "Add Dockerfile for apps/pipecat-bot"
```

### Task 5.3: Temporal worker Docker build

**Files:**
- Create: `workers/temporal-worker/Dockerfile`
- Create: `workers/temporal-worker/.dockerignore`

- [ ] **Step 1:** Create `workers/temporal-worker/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# prisma-client-python ships its own JS prisma binary downloader; no system
# Node/npm needed at build time (uv run prisma generate handles it).

COPY workers/temporal-worker/pyproject.toml workers/temporal-worker/uv.lock /app/
COPY prisma /app/prisma
RUN ln -sf /app/prisma/schema.prisma /app/schema.prisma
RUN uv sync --frozen --no-dev
RUN uv run prisma generate

COPY workers/temporal-worker/quotid_worker /app/quotid_worker

CMD ["uv", "run", "python", "-m", "quotid_worker.main"]
```

(If `uv run prisma generate` fails inside the image because prisma-client-python can't auto-fetch its JS shim — uncommon but possible on minimal images — add `RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*` back before `uv sync`.)

- [ ] **Step 2:** Create `workers/temporal-worker/.dockerignore`:

```
.venv
__pycache__
*.pyc
tests
scripts
.env*
```

- [ ] **Step 3:** Build locally:

```bash
docker build -f workers/temporal-worker/Dockerfile -t quotid-worker:dev .
```

- [ ] **Step 4:** Commit:

```bash
git add workers/temporal-worker/Dockerfile workers/temporal-worker/.dockerignore
git commit -m "Add Dockerfile for workers/temporal-worker"
```

### Task 5.4: `compose.yaml`

**Files:**
- Create: `compose.yaml`

- [ ] **Step 1:** Create:

```yaml
name: quotid

networks:
  quotid:
    driver: bridge

volumes:
  temporal-data:
  caddy-data:
  caddy-config:

services:
  temporal:
    image: temporalio/admin-tools:latest
    command: ["temporal", "server", "start-dev", "--ip", "0.0.0.0", "--ui-port", "8233"]
    networks: [quotid]
    volumes:
      - temporal-data:/etc/temporal
    healthcheck:
      test: ["CMD", "temporal", "operator", "namespace", "list"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  worker:
    build:
      context: .
      dockerfile: workers/temporal-worker/Dockerfile
    env_file: .env
    environment:
      TEMPORAL_ADDRESS: temporal:7233
      # Override the .env value: in compose, the worker reaches the bot
      # over the internal Docker network, NOT through Caddy (which 403s
      # public POST /calls per decision #14).
      BOT_INTERNAL_URL: http://bot:8000
    networks: [quotid]
    depends_on:
      temporal:
        condition: service_healthy
    restart: unless-stopped

  bot:
    build:
      context: .
      dockerfile: apps/pipecat-bot/Dockerfile
    env_file: .env
    environment:
      TEMPORAL_ADDRESS: temporal:7233
    networks: [quotid]
    depends_on:
      temporal:
        condition: service_healthy
    restart: unless-stopped

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    env_file: .env
    environment:
      TEMPORAL_ADDRESS: temporal:7233
    networks: [quotid]
    depends_on:
      temporal:
        condition: service_healthy
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    networks: [quotid]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on: [web, bot]
    restart: unless-stopped
```

- [ ] **Step 2:** Commit:

```bash
git add compose.yaml
git commit -m "Add compose.yaml for single-host deployment"
```

### Task 5.5: `Caddyfile`

**Files:**
- Create: `Caddyfile`

- [ ] **Step 1:** Create. Replace `bot.YOUR_DOMAIN.com` and `app.YOUR_DOMAIN.com` with your real subdomains:

```Caddyfile
# Quotid reverse proxy + auto-TLS via Let's Encrypt.

app.YOUR_DOMAIN.com {
  encode gzip
  reverse_proxy web:3000
}

bot.YOUR_DOMAIN.com {
  encode gzip

  # Pipecat's POST /calls is internal-only — block public access.
  @internal_call_create {
    method POST
    path /calls
  }
  respond @internal_call_create 403

  # /calls/{sid}/twiml and /calls/{sid}/stream are public (Twilio reaches them).
  reverse_proxy bot:8000
}
```

- [ ] **Step 2:** Commit:

```bash
git add Caddyfile
git commit -m "Add Caddyfile with public/internal route split"
```

### Task 5.6: Provision the Oracle host

This task runs against the actual Oracle A1 instance once Pre-Task A succeeds. If Oracle is still out-of-capacity by deadline, fall back to the Hetzner CAX11 path — the only thing that changes is the SSH host.

- [ ] **Step 1:** SSH in:

```bash
ssh ubuntu@<your-oracle-public-ip>
```

- [ ] **Step 2:** Install Docker:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker ubuntu
exit  # log out and back in for the group to apply
```

- [ ] **Step 3:** Open ports 80 and 443 in the Oracle Cloud security list (web console: VCN → Security Lists → ingress rules):
  - TCP 80 from 0.0.0.0/0
  - TCP 443 from 0.0.0.0/0

  Also enable in Ubuntu's local firewall:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

- [ ] **Step 4:** Set DNS A records for `app.YOUR_DOMAIN.com` and `bot.YOUR_DOMAIN.com` pointing at the Oracle public IP. (Cloudflare DNS or wherever your DNS lives; **disable** Cloudflare proxy for these records — Caddy needs direct connections to issue Let's Encrypt certs via HTTP-01 challenge.)

- [ ] **Step 5:** Clone the repo:

```bash
git clone <your-quotid-repo-url> ~/quotid
cd ~/quotid
```

- [ ] **Step 6:** Copy your local `.env` to the server. From your **local** machine:

```bash
scp .env ubuntu@<oracle-ip>:~/quotid/.env
```

(Or use a vault/age-encrypted file — for a 2-day demo, scp is fine.)

- [ ] **Step 7:** Edit `Caddyfile` on the server to match your real domains. Edit `.env` to set `BOT_PUBLIC_URL=https://bot.YOUR_DOMAIN.com` and `APP_PUBLIC_URL=https://app.YOUR_DOMAIN.com`.

- [ ] **Step 8:** First boot:

```bash
docker compose up -d --build
```

Watch logs:

```bash
docker compose logs -f
```

Expected within ~2 minutes:
  - `temporal` reports a healthy server
  - `worker` logs `INFO Worker started`
  - `bot` logs `Uvicorn running on http://0.0.0.0:8000`
  - `web` logs `Ready in <ms>`
  - `caddy` logs Let's Encrypt successful for both domains

- [ ] **Step 9:** No commit (this is configuration, not code).

### Task 5.7: First call against deployed system

- [ ] **Step 1:** Hit `https://app.YOUR_DOMAIN.com` from your phone. Log in with your seeded passcode.

- [ ] **Step 2:** Click "Trigger nightly call." Phone rings; carry on as in slice 4 Task 4.13.

- [ ] **Step 3:** If the call works end-to-end on a real domain with a real cert, slice 5 is done.

- [ ] **Step 4:** Capture a short screen-recording of the demo for the interview. Two takes: one of the UI flow, one with phone audio.

- [ ] **Step 5:** Push to GitHub. The branch is currently 12+ commits ahead of `origin/main` from prior sessions plus everything from slices 1–5. Per the repo's commit-style rules, do NOT push without explicit user consent. Surface the count and ask before pushing:

```bash
git log --oneline origin/main..HEAD | wc -l
```

**Slice 5 done.** The demo runs from a real public URL on free Oracle infrastructure. Total cost: $0/mo infra + ~$1 in Twilio + $1 in OpenRouter.

---
## Slice 6 — Bonus: nightly schedule toggle (placeholder)

Build only if S1–S5 land by end of day 1. One-line plan: add a `<ScheduleToggle />` Client Component on `/journal-entries` that calls a `setSchedule({ enabled, localTimeOfDay })` Server Action; the action upserts a `CallSchedule` row, then uses `@temporalio/client`'s `client.schedule.create({ scheduleId: ` + "`journal:${userId}`" + `, spec: { calendars: [{ hour: 21, minute: 0 }], timeZone: user.timezone }, action: { type: 'startWorkflow', workflowType: 'JournalingWorkflow', workflowId: ` + "`journal-${userId}`" + `, args: [{ user_id: userId, call_schedule_id: scheduleRow.id, scheduled_for: <fire-time-placeholder> }], taskQueue: 'quotid-main' } })` to create or update the matching Temporal Schedule, with `client.schedule.getHandle(scheduleId).delete()` on disable. Schedule ID, workflow ID base, task queue, and input shape all match `temporal-workflow.md` §4.

**Do not pre-design further.** If you have time, draft a slice-6 plan in the same shape as slices 1–5 before writing code.

---
## Self-review (post-write checklist)

Before executing, the implementing engineer should re-read this plan with fresh eyes against the original spec (`docs/SESSION_HANDOFF.md` + `docs/architecture/`).

**Spec coverage check:**

| Spec requirement | Where it lands |
|------------------|----------------|
| Step 1 — C4 architecture | Already shipped (`docs/architecture/likec4/quotid.c4`); no plan task |
| Step 2 — Data model + dual-URL Neon | Slice 1 Task 1.3 |
| Step 3 — Temporal workflow + retries + async completion | Slices 2 + 4 |
| Step 4 — REST contract (Zalando snake_case) | Slice 1 Task 1.10 codec; Slice 4 Task 4.9 webhook |
| Step 4 — Server Actions camelCase | Slice 3 Task 3.2 |
| Step 5 — Pipecat pipeline (Silero + SmartTurn + accumulator) | Slice 4 Tasks 4.5, 4.6 |
| Step 6 — Modal canonical transcript | Deferred per decision #15; `CANONICAL_TRANSCRIPT_ENABLED` flag not wired in MVP |
| Auth — passcode-on-User + argon2id + Session | Slice 1 Tasks 1.4–1.7 |
| Decision #14 — Caddy public-only, /calls internal | Slice 5 Task 5.5 |
| Decision #11 — `QuotidCartesiaTTSService` Modal seam | Slice 4 Task 4.6 |
| Decision #8 — Twilio statusCallback watchdog | Slice 4 Task 4.9 |

**Acknowledged not-in-plan items:**
- Modal canonical transcript activity (decision #15 — deferred to post-MVP)
- Schedule UI (placeholder slice 6)
- Recording playback in entry detail (UI affordance not in MVP scope)
- Cartesia voice tuning, system-prompt iteration (post-scaffold prompt engineering)
- 10-min hard cap on conversation length (covered by Temporal `start_to_close_timeout=20min` on `await_call`; not separately enforced inside the bot)
- Sliding-window session refresh (skipped; 30-day fixed TTL until first re-login)

**Known points where the plan slightly extends the spec:**
- Login Route Handler accepts both `application/x-www-form-urlencoded` (HTML form path) and `application/json` (testability). The OpenAPI spec at `docs/architecture/api/nextjs.openapi.yaml` currently shows JSON-only. After landing slice 1, update the spec to document the form encoding and the 303-redirect responses.
- `apps/web/lib/codec.ts` adds a runtime camelCase↔snake_case codec at the HTTP boundary, instead of using Prisma's `@@map` to rename fields server-side. Equivalent observable behavior; the codec is one file the engineer can audit.
- `cloudflared/config.yml.example` is a dev-only artifact and not strictly part of any architecture doc; deploy uses Caddy's auto-TLS instead.

**Things to double-check before starting:**
1. Pre-Task A (Oracle provisioning) is running before opening the editor. Out-of-host-capacity is the dominant external risk.
2. All Pre-Task C API keys captured to a password manager — do **not** check `.env` in.
3. Temporal Python SDK version pinned to `>=1.7` (uses `pydantic_data_converter` and `WorkflowEnvironment.start_time_skipping`).
4. Pipecat version `>=0.0.50` (the API names used in slice 4 — `LLMUserAggregator`, `LLMAssistantAggregator`, `LocalSmartTurnAnalyzerV3` — match this release line).

---
