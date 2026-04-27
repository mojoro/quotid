# Server Actions — Quotid

Next.js 16 Server Actions. **Not REST**, not in the OpenAPI spec — these are internal TypeScript-to-TypeScript RPC invocations between the Quotid UI (client components) and the Next.js server runtime.

## Why not REST?

Server Actions bundle the mutation contract with React's `<form action={...}>` / `useActionState` lifecycle. They handle CSRF, serialization, and revalidation (via `revalidatePath` / `revalidateTag`) automatically. Wrapping them in REST would duplicate work and lose the framework integration. Zalando explicitly permits non-REST internal endpoints (§101 — "don't force HTTP semantics onto non-HTTP interactions").

## Return shape convention

Each action returns its own discriminated union — there is no shared `ServerActionResult<T>` wrapper. The pattern is uniform:

```ts
type ResultOk = { ok: true } & PerActionPayload;
type ResultErr = { ok: false; error: string };
type Result = ResultOk | ResultErr;
```

The success branch carries action-specific fields (e.g. `entry`, `profile`, `schedule`, `voice`, `workflowId`); the error branch is a flat string for direct rendering in form status lines. Validation, auth, and known infra failures all return `{ ok: false }`. Actions **never throw** for anticipated failures — throwing escapes React's form lifecycle and is reserved for programmer errors (DB down, Temporal client crash).

## Actions

### `updateCallSchedule`

**File:** `app/(app)/settings/actions.ts`
**Caller:** Settings page (`/settings`), form with time picker, day-of-week chips, and enabled toggle.

```ts
'use server';

export type UpdateCallScheduleInput = {
  localTimeOfDay: string; // "HH:MM", 24h, in user's timezone
  enabled: boolean;
  daysOfWeek: number;    // 0..127 bitmask, bit 0 = Sunday … bit 6 = Saturday
};

export type UpdateCallScheduleResult =
  | {
      ok: true;
      schedule: {
        id: string;
        localTimeOfDay: string;
        enabled: boolean;
        daysOfWeek: number;
        temporalScheduleId: string;
      };
    }
  | { ok: false; error: string };

export async function updateCallSchedule(
  input: UpdateCallScheduleInput
): Promise<UpdateCallScheduleResult>;
```

**Side effects:**
1. Validates `localTimeOfDay` matches `^([01]\d|2[0-3]):[0-5]\d$`.
2. Validates `daysOfWeek` is an integer in `[0, 127]` (7-bit mask).
3. UPSERTs `call_schedules` row for the authenticated user.
4. Creates-or-updates the corresponding Temporal Schedule (ID: `journal:{userId}`) via the Temporal TypeScript client. See `docs/architecture/temporal-workflow.md` §4.
5. Translates `daysOfWeek` into the schedule's calendar spec:
   - All 7 bits set (`0b1111111` = 127) → no `dayOfWeek` filter, fires every day.
   - Subset → `calendars[0].dayOfWeek` is set to the corresponding `["SUNDAY"..."SATURDAY"]` array (Temporal calendar day-name enum).
   - 0 bits set (`0`) → schedule is paused regardless of `enabled` (no day means no fire; pausing avoids drift).
6. Pauses / unpauses via `handle.pause()` / `handle.unpause()`. The schedule is "effectively paused" when `enabled=false` OR `daysOfWeek=0`.
7. Calls `revalidatePath('/settings')` so the server-rendered page picks up the new state.

**Atomicity:** DB write and Temporal Schedule mutation are NOT in a distributed transaction. Order is: DB first, Temporal second. If Temporal fails after DB succeeds, the action returns `{ ok: false, error }` and a backfill cron (out of MVP scope) would reconcile. For MVP, the happy path is reliable enough; a failed sync shows a user-visible error and asks them to retry.

**Errors (returned as `{ ok: false, error: string }`):**

| `error` substring | When |
|---|---|
| `localTimeOfDay must be HH:MM (24h)` | Time format invalid. |
| `daysOfWeek must be a 7-bit bitmask (0-127)` | Out-of-range or non-integer mask. |
| `user not found` | Authenticated `userId` has no `User` row (defensive). |
| `temporal sync failed: …` | DB wrote, Temporal failed. State is drifted; user should retry. |

---

### `updateProfile`

**File:** `app/(app)/settings/actions.ts`
**Caller:** Settings page profile form (name + phone + timezone).

```ts
'use server';

export type UpdateProfileInput = {
  name: string | null;
  phoneNumber: string;  // E.164
  timezone: string;     // IANA tz database name, e.g. "Europe/Berlin"
};

export type UpdateProfileResult =
  | { ok: true; profile: { name: string | null; phoneNumber: string; timezone: string } }
  | { ok: false; error: string };

export async function updateProfile(
  input: UpdateProfileInput
): Promise<UpdateProfileResult>;
```

**Validation:**
- `name` is trimmed; empty string becomes `null`. Max length 80 chars.
- `phoneNumber` must match `^\+[1-9]\d{6,14}$` (E.164).
- `timezone` is probed via `new Intl.DateTimeFormat("en-US", { timeZone: tz })`; anything that throws is rejected as invalid.

**Side effects:**
1. Updates the authenticated user's `User` row (`name`, `phoneNumber`, `timezone`).
2. **Re-syncs the existing Temporal schedule** if one exists. Temporal stores `timezone` on the schedule spec, so changing `user.timezone` would otherwise drift the schedule into the old zone. The action loads the current `CallSchedule` row and re-invokes `updateCallSchedule(...)` with the existing time / enabled / daysOfWeek values to push the new timezone into Temporal.
3. Calls `revalidatePath('/settings')`.

**Errors (returned as `{ ok: false, error: string }`):**

| `error` substring | When |
|---|---|
| `name must be ≤80 chars` | Trimmed name exceeds the limit. |
| `phone must be E.164 …` | Phone fails the E.164 regex. |
| `invalid IANA timezone` | `Intl.DateTimeFormat` rejects the timezone. |
| `phone number already in use` | Prisma unique-constraint violation (multi-user prep; defensive in MVP). |
| `update failed: …` | Any other Prisma error, surface as-is. |
| `temporal sync failed: …` | The downstream `updateCallSchedule` re-sync failed; surfaced verbatim. |

---

### `updateVoicePreference`

**File:** `app/(app)/settings/actions.ts`
**Caller:** Settings page voice picker; called after the user auditions and selects an Aura 2 voice.

```ts
'use server';

export type UpdateVoiceResult =
  | { ok: true; voice: VoiceId }
  | { ok: false; error: string };

export async function updateVoicePreference(
  voice: string
): Promise<UpdateVoiceResult>;
```

**Validation:** `voice` must match an `id` in `AVAILABLE_VOICES`.

**Important — neutral module split:** `AVAILABLE_VOICES` and the `VoiceId` type live in `app/(app)/settings/voices.ts`, not in `actions.ts`. A `"use server"` file may export only async functions, so the const + type must sit in a sibling neutral module. Both the action and the client-side voice picker import from `./voices`.

**Side effects:**
1. Updates `User.voicePreference` for the authenticated user.
2. Calls `revalidatePath('/settings')`.

The bot reads `User.voicePreference` at call-trigger time (via the worker) and passes it as `voice` on `POST /calls` — see `pipecat-bot.openapi.yaml` `CreateCallRequest.voice`.

**Errors (returned as `{ ok: false, error: string }`):**

| `error` substring | When |
|---|---|
| `unknown voice` | `voice` is not in the allowlist. |

---

### `triggerCall`

**File:** `app/(app)/journal-entries/actions.ts` (co-located with `updateJournalEntry`)
**Caller:** "Ring me now" button on the journal page. Useful for verifying the flow without waiting until the scheduled time.

```ts
'use server';

export type TriggerCallResult =
  | { ok: true; workflowId: string }
  | { ok: false; error: string };

export async function triggerCall(): Promise<TriggerCallResult>;
```

**Side effects:**
1. Reads authenticated user's `User` row (phone, timezone, voicePreference, name) — the `create_call_session` activity does the actual reads downstream.
2. Generates workflow ID: `journal-{userId}-manual-{YYYYMMDDTHHMMSS}Z` (second precision; collisions are returned verbatim by Temporal).
3. Starts `JournalingWorkflow` via the Temporal TS client (`client.workflow.start(...)`) on the configured task queue.
4. Calls `revalidatePath('/journal-entries')` so the journal list re-renders with the new pending CallSession.
5. Returns `workflowId` so the UI can poll status.

**Errors (returned as `{ ok: false, error: string }`):**

| `error` substring | When |
|---|---|
| `WorkflowAlreadyStartedError` (or similar from Temporal) | Two triggers in the same second collided. Rare; UI should show a brief "try again." |
| any other Temporal client message | Temporal client error, surfaced verbatim. |

---

### `updateJournalEntry`

**File:** `app/(app)/journal-entries/actions.ts`
**Caller:** Entry detail editor (`components/journal/entry-editor.client.tsx`) on `/journal-entries/{id}`.

```ts
'use server';

export type UpdateJournalEntryInput = {
  id: string;
  // Partial update — only `title` and `body` are user-editable.
  title?: string;
  body?: string;
};

export type UpdateJournalEntryResult =
  | {
      ok: true;
      entry: { id: string; title: string; body: string; isEdited: boolean };
    }
  | { ok: false; error: string };

export async function updateJournalEntry(
  input: UpdateJournalEntryInput
): Promise<UpdateJournalEntryResult>;
```

**Side effects:**
1. Verifies the entry belongs to the authenticated user (`WHERE id = ? AND user_id = ?`).
2. UPDATES `title` / `body` as provided. Sets `is_edited=true` if `body` diverges from `generated_body`.
3. `updated_at` is bumped by Prisma's `@updatedAt`.
4. Calls `revalidatePath('/journal-entries')` and `revalidatePath('/journal-entries/{id}')` so list + detail views re-render server-side.

**Note:** `generated_body` is never mutated by this action. Preserving the original LLM output is the whole point of the two-column design (see `schema.prisma` comment on `JournalEntry`).

**Errors (returned as `{ ok: false, error: string }`):**

| `error` substring | When |
|---|---|
| `not found` | Entry doesn't exist or isn't owned by the user (merged for opacity). |
| `title cannot be empty` | `title` provided but empty after trim. |

## Revalidation strategy

Each action calls `revalidatePath` for the route(s) whose server-rendered output depends on the data it just changed. There is no `revalidateTag` usage — paths are simpler and accurate when only one or two routes need to refresh after a mutation.

| Action | Paths revalidated |
|---|---|
| `updateCallSchedule` | `/settings` |
| `updateProfile` | `/settings` |
| `updateVoicePreference` | `/settings` |
| `updateJournalEntry` | `/journal-entries`, `/journal-entries/{id}` |
| `triggerCall` | `/journal-entries` |

TanStack Query on the client doesn't integrate directly with `revalidatePath` — after a successful action, callers also invoke `queryClient.invalidateQueries({ queryKey: [...] })` for any client-cached data they want to refetch.

## What's deliberately NOT a Server Action

- **`listJournalEntries`** — read, not mutation. Stays a Route Handler so TanStack Query can do its normal GET lifecycle (cache, retry, background refetch). Server Actions can't stream, can't be HTTP-cached by the browser, and produce worse DX for reads.
- **`createUser`** — no signup flow in MVP (single user, seeded manually).
- **`login` / `logout`** — session handling goes through dedicated Route Handlers (`POST /api/auth/login`, `POST /api/auth/logout`), not actions, because cookie manipulation semantics are cleaner there and middleware needs to redirect on them.
