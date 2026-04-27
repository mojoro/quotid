"use server";

import { revalidatePath } from "next/cache";
import { ScheduleAlreadyRunning, ScheduleOverlapPolicy } from "@temporalio/client";
import { currentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getTemporalClient, TASK_QUEUE } from "@/lib/temporal-client";

export type UpdateCallScheduleInput = {
  localTimeOfDay: string;
  enabled: boolean;
  daysOfWeek: number;
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

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS_MASK_MAX = 0b1111111;

export async function updateCallSchedule(
  input: UpdateCallScheduleInput,
): Promise<UpdateCallScheduleResult> {
  if (!TIME_OF_DAY.test(input.localTimeOfDay)) {
    return { ok: false, error: "localTimeOfDay must be HH:MM (24h)" };
  }
  if (
    !Number.isInteger(input.daysOfWeek) ||
    input.daysOfWeek < 0 ||
    input.daysOfWeek > DAYS_MASK_MAX
  ) {
    return { ok: false, error: "daysOfWeek must be a 7-bit bitmask (0-127)" };
  }

  const userId = await currentUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  if (!user) return { ok: false, error: "user not found" };

  const row = await prisma.callSchedule.upsert({
    where: { userId },
    create: {
      userId,
      localTimeOfDay: input.localTimeOfDay,
      enabled: input.enabled,
      daysOfWeek: input.daysOfWeek,
    },
    update: {
      localTimeOfDay: input.localTimeOfDay,
      enabled: input.enabled,
      daysOfWeek: input.daysOfWeek,
    },
  });

  const scheduleId = `journal:${userId}`;
  const [hourStr, minuteStr] = input.localTimeOfDay.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);

  const dayOfWeek = bitmaskToDayOfWeek(input.daysOfWeek);
  const effectivelyPaused = !input.enabled || input.daysOfWeek === 0;

  const client = await getTemporalClient();

  const action = {
    type: "startWorkflow" as const,
    workflowType: "JournalingWorkflow",
    workflowId: `journal-${userId}`,
    taskQueue: TASK_QUEUE,
    args: [
      {
        user_id: userId,
        call_schedule_id: row.id,
        scheduled_for: new Date(0).toISOString(),
      },
    ],
  };

  const calendar: {
    hour: number;
    minute: number;
    dayOfWeek?: DayOfWeekName[];
  } = { hour, minute };
  if (dayOfWeek !== null) calendar.dayOfWeek = dayOfWeek;

  const spec = {
    calendars: [calendar],
    timezone: user.timezone,
  };

  const policies = {
    overlap: ScheduleOverlapPolicy.SKIP,
    catchupWindow: "10 minutes",
    pauseOnFailure: false,
  };

  try {
    if (row.temporalScheduleId) {
      const handle = client.schedule.getHandle(row.temporalScheduleId);
      await handle.update(() => ({
        action,
        spec,
        policies,
        state: { paused: effectivelyPaused },
      }));
      if (effectivelyPaused) await handle.pause();
      else await handle.unpause();
    } else {
      try {
        await client.schedule.create({
          scheduleId,
          action,
          spec,
          policies,
          state: { paused: effectivelyPaused },
        });
      } catch (e) {
        if (!(e instanceof ScheduleAlreadyRunning)) throw e;
        const handle = client.schedule.getHandle(scheduleId);
        await handle.update(() => ({
          action,
          spec,
          policies,
          state: { paused: effectivelyPaused },
        }));
        if (effectivelyPaused) await handle.pause();
        else await handle.unpause();
      }
      await prisma.callSchedule.update({
        where: { id: row.id },
        data: { temporalScheduleId: scheduleId },
      });
    }
  } catch (e) {
    return {
      ok: false,
      error: `temporal sync failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  revalidatePath("/settings");

  return {
    ok: true,
    schedule: {
      id: row.id,
      localTimeOfDay: input.localTimeOfDay,
      enabled: input.enabled,
      daysOfWeek: input.daysOfWeek,
      temporalScheduleId: row.temporalScheduleId ?? scheduleId,
    },
  };
}

type DayOfWeekName =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";

const DAY_NAMES: DayOfWeekName[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

function bitmaskToDayOfWeek(mask: number): DayOfWeekName[] | null {
  if (mask === DAYS_MASK_MAX) return null;
  const out: DayOfWeekName[] = [];
  for (let i = 0; i < 7; i++) if (mask & (1 << i)) out.push(DAY_NAMES[i]);
  return out;
}

// ─── Profile ──────────────────────────────────────────────────────────────

export type UpdateProfileInput = {
  name: string | null;
  phoneNumber: string;
  timezone: string;
};

export type UpdateProfileResult =
  | { ok: true; profile: { name: string | null; phoneNumber: string; timezone: string } }
  | { ok: false; error: string };

const E164 = /^\+[1-9]\d{6,14}$/;
const NAME_MAX = 80;

export async function updateProfile(
  input: UpdateProfileInput,
): Promise<UpdateProfileResult> {
  const name = input.name?.trim() || null;
  if (name && name.length > NAME_MAX) {
    return { ok: false, error: `name must be ≤${NAME_MAX} chars` };
  }
  if (!E164.test(input.phoneNumber)) {
    return { ok: false, error: "phone must be E.164 (e.g. +14155551234)" };
  }
  if (!isValidTimezone(input.timezone)) {
    return { ok: false, error: "invalid IANA timezone" };
  }

  const userId = await currentUserId();
  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        name,
        phoneNumber: input.phoneNumber,
        timezone: input.timezone,
      },
      select: { name: true, phoneNumber: true, timezone: true },
    });

    // If timezone changed, the Temporal schedule's timezone field is stale.
    // Reuse the existing schedule row and re-sync.
    const schedule = await prisma.callSchedule.findUnique({
      where: { userId },
      select: { localTimeOfDay: true, enabled: true, daysOfWeek: true },
    });
    if (schedule) {
      const result = await updateCallSchedule({
        localTimeOfDay: schedule.localTimeOfDay,
        enabled: schedule.enabled,
        daysOfWeek: schedule.daysOfWeek,
      });
      if (!result.ok) return { ok: false, error: result.error };
    }

    revalidatePath("/settings");
    return { ok: true, profile: updated };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Unique constraint")) {
      return { ok: false, error: "phone number already in use" };
    }
    return { ok: false, error: `update failed: ${msg}` };
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── Voice ────────────────────────────────────────────────────────────────

export const AVAILABLE_VOICES = [
  {
    id: "aura-2-thalia-en",
    name: "Thalia",
    desc: "Warm, mid-range, evening",
  },
  {
    id: "aura-2-orion-en",
    name: "Orion",
    desc: "Lower, slower, contemplative",
  },
  {
    id: "aura-2-luna-en",
    name: "Luna",
    desc: "Soft, conversational, friendly",
  },
] as const;

export type VoiceId = (typeof AVAILABLE_VOICES)[number]["id"];

export type UpdateVoiceResult =
  | { ok: true; voice: VoiceId }
  | { ok: false; error: string };

export async function updateVoicePreference(voice: string): Promise<UpdateVoiceResult> {
  if (!AVAILABLE_VOICES.some((v) => v.id === voice)) {
    return { ok: false, error: "unknown voice" };
  }
  const userId = await currentUserId();
  await prisma.user.update({
    where: { id: userId },
    data: { voicePreference: voice },
  });
  revalidatePath("/settings");
  return { ok: true, voice: voice as VoiceId };
}
