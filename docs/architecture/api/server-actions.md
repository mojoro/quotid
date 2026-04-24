# Server Actions — Quotid

Next.js 16 Server Actions. **Not REST**, not in the OpenAPI spec — these are internal TypeScript-to-TypeScript RPC invocations between the Quotid UI (client components) and the Next.js server runtime.

## Why not REST?

Server Actions bundle the mutation contract with React's `<form action={...}>` / `useActionState` lifecycle. They handle CSRF, serialization, and revalidation (via `revalidatePath` / `revalidateTag`) automatically. Wrapping them in REST would duplicate work and lose the framework integration. Zalando explicitly permits non-REST internal endpoints (§101 — "don't force HTTP semantics onto non-HTTP interactions").

## Shared types

```ts
// lib/actions/types.ts

export type ServerActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError };

export type ActionError = {
  // Zalando-compatible subset of RFC 7807.
  type: string;        // stable URI-ish identifier, e.g. "validation/invalid-time-of-day"
  title: string;       // human-readable one-liner
  detail?: string;     // longer explanation
  fieldErrors?: Record<string, string>; // per-field for form rendering
};
```

All four actions return `ServerActionResult<T>`. They **never throw** for anticipated failures (validation, auth) — throwing escapes React's form lifecycle and is reserved for programmer errors (DB down, Temporal client crash).

## Actions

### `updateCallSchedule`

**File:** `app/actions/call-schedule.ts`
**Caller:** Settings page (`/settings`), form with time picker + enabled toggle.

```ts
'use server';

export type UpdateCallScheduleInput = {
  localTimeOfDay: string; // "HH:MM", 24h, in user's timezone
  enabled: boolean;
};

export async function updateCallSchedule(
  input: UpdateCallScheduleInput
): Promise<ServerActionResult<CallSchedule>>;
```

**Side effects:**
1. Validates `localTimeOfDay` matches `^([01]\d|2[0-3]):[0-5]\d$`.
2. UPSERTs `call_schedules` row for the authenticated user.
3. Creates-or-updates the corresponding Temporal Schedule (ID: `journal:{userId}`) via the Temporal TypeScript client. See `docs/architecture/temporal-workflow.md` §4.
4. If `enabled=false`, pauses the Temporal Schedule (`ScheduleState.paused`).
5. Calls `revalidateTag('call-schedules')` so TanStack Query re-fetches.

**Atomicity:** DB write and Temporal Schedule mutation are NOT in a distributed transaction. Order is: DB first, Temporal second. If Temporal fails after DB succeeds, the action returns `{ ok: false, error }` and a backfill cron (out of MVP scope) would reconcile. For MVP, the happy path is reliable enough; a failed sync shows a user-visible error and asks them to retry.

**Errors:**

| `type` | When |
|---|---|
| `validation/invalid-time-of-day` | `localTimeOfDay` doesn't match the HH:MM pattern. |
| `auth/unauthenticated` | No session cookie. |
| `temporal/sync-failed` | DB wrote, Temporal failed. State is drifted; user should retry. |

---

### `triggerTestCall`

**File:** `app/actions/call-schedule.ts` (co-located with `updateCallSchedule`)
**Caller:** "Ring me now" button on the settings page. Dev/testing convenience, but ships to prod — useful for users to verify the flow works without waiting until 9 pm.

```ts
'use server';

export type TriggerTestCallInput = {
  // Optional: override `scheduled_for` for backdated testing. Defaults to now.
  scheduledFor?: string; // ISO-8601
};

export async function triggerTestCall(
  input?: TriggerTestCallInput
): Promise<ServerActionResult<{ workflowId: string }>>;
```

**Side effects:**
1. Reads authenticated user's `User` row (phone, timezone).
2. Generates workflow ID: `journal-{userId}-manual-{YYYYMMDDTHHMMSS}` (second precision — see `docs/architecture/temporal-workflow.md` §7).
3. Starts `JournalingWorkflow` via Temporal client (`client.start_workflow(...)`) on task queue `quotid-main`.
4. Returns `workflowId` so the UI can poll or link to the Temporal dashboard.

**Errors:**

| `type` | When |
|---|---|
| `auth/unauthenticated` | No session cookie. |
| `validation/missing-phone` | User has no `phoneNumber` set (shouldn't happen; defensive). |
| `temporal/start-failed` | Temporal client errored. |
| `temporal/duplicate-workflow-id` | Two triggers in the same second → second fails with `WorkflowAlreadyStartedError`. Second-precision suffix makes this extremely rare, but handle anyway — return as typed error so UI shows a brief "try again" message. |

---

### `updateJournalEntry`

**File:** `app/actions/journal-entry.ts`
**Caller:** Journal entry edit page (`/journal-entries/{id}/edit`).

```ts
'use server';

export type UpdateJournalEntryInput = {
  id: string;
  // Partial update — only `title` and `body` are user-editable.
  title?: string;
  body?: string;
};

export async function updateJournalEntry(
  input: UpdateJournalEntryInput
): Promise<ServerActionResult<JournalEntry>>;
```

**Side effects:**
1. Verifies the entry belongs to the authenticated user (`WHERE id = ? AND user_id = ?`).
2. UPDATES `title` / `body` as provided. Sets `is_edited=true` if `body` diverges from `generated_body`.
3. `updated_at` is bumped by Prisma's `@updatedAt`.
4. `revalidateTag('journal-entries')` so list + detail views refetch.

**Note:** `generated_body` is never mutated by this action. Preserving the original LLM output is the whole point of the two-column design (see `schema.prisma` comment on `JournalEntry`).

**Errors:**

| `type` | When |
|---|---|
| `auth/unauthenticated` | No session cookie. |
| `not-found` | Entry doesn't exist or isn't owned by the user (merged for opacity). |
| `validation/empty-title` | Title is empty string after trim. |

---

### `deleteJournalEntry`

**File:** `app/actions/journal-entry.ts`
**Caller:** Journal entry detail page, "delete" button (with confirmation dialog).

```ts
'use server';

export async function deleteJournalEntry(
  id: string
): Promise<ServerActionResult<{ id: string }>>;
```

**Side effects:**
1. Verifies ownership.
2. `DELETE` from `journal_entries` (hard delete — MVP has no undo; user-confirmed before calling).
3. The associated `CallSession` is NOT deleted — the call happened, that record stays. `CallSession.journalEntry` naturally becomes null: the FK lives on the JournalEntry side (`call_sessions_id` column in `journal_entries`), so there's nothing to cascade; the `CallSession.journalEntry` back-reference just resolves to null once the JournalEntry row is gone.
4. `revalidateTag('journal-entries')`.

**Errors:**

| `type` | When |
|---|---|
| `auth/unauthenticated` | No session cookie. |
| `not-found` | Entry doesn't exist or isn't owned by the user. |

## Revalidation strategy

Tags used by these actions:

| Tag | Actions that invalidate | Readers that subscribe |
|---|---|---|
| `call-schedules` | `updateCallSchedule` | `GET /api/call-schedules` Route Handler |
| `journal-entries` | `updateJournalEntry`, `deleteJournalEntry` | `GET /api/journal-entries*` Route Handlers |

TanStack Query on the client doesn't integrate directly with Next.js tags — after a successful action, the UI calls `queryClient.invalidateQueries({ queryKey: [...] })` as well. The Next.js tag-based revalidation handles server-rendered pages; TanStack handles client-cached data. Both are needed.

## What's deliberately NOT a Server Action

- **`listJournalEntries`** — read, not mutation. Stays a Route Handler so TanStack Query can do its normal GET lifecycle (cache, retry, background refetch). Server Actions can't stream, can't be HTTP-cached by the browser, and produce worse DX for reads.
- **`createUser`** — no signup flow in MVP (single user, seeded manually).
- **`login` / `logout`** — session handling goes through dedicated Route Handlers (`POST /api/auth/login`, `POST /api/auth/logout`), not actions, because cookie manipulation semantics are cleaner there and middleware needs to redirect on them.
