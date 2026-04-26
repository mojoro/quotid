"use server";

import { revalidatePath } from "next/cache";
import { ScheduleAlreadyRunning, ScheduleOverlapPolicy } from "@temporalio/client";
import { currentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getTemporalClient, TASK_QUEUE } from "@/lib/temporal-client";

export type UpdateCallScheduleInput = {
  localTimeOfDay: string;
  enabled: boolean;
};

export type UpdateCallScheduleResult =
  | {
      ok: true;
      schedule: {
        id: string;
        localTimeOfDay: string;
        enabled: boolean;
        temporalScheduleId: string;
      };
    }
  | { ok: false; error: string };

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function updateCallSchedule(
  input: UpdateCallScheduleInput,
): Promise<UpdateCallScheduleResult> {
  if (!TIME_OF_DAY.test(input.localTimeOfDay)) {
    return { ok: false, error: "localTimeOfDay must be HH:MM (24h)" };
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
    },
    update: {
      localTimeOfDay: input.localTimeOfDay,
      enabled: input.enabled,
    },
  });

  const scheduleId = `journal:${userId}`;
  const [hourStr, minuteStr] = input.localTimeOfDay.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);

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

  const spec = {
    calendars: [{ hour, minute }],
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
        state: { paused: !input.enabled },
      }));
      if (input.enabled) await handle.unpause();
      else await handle.pause();
    } else {
      try {
        await client.schedule.create({
          scheduleId,
          action,
          spec,
          policies,
          state: { paused: !input.enabled },
        });
      } catch (e) {
        if (!(e instanceof ScheduleAlreadyRunning)) throw e;
        const handle = client.schedule.getHandle(scheduleId);
        await handle.update(() => ({
          action,
          spec,
          policies,
          state: { paused: !input.enabled },
        }));
        if (input.enabled) await handle.unpause();
        else await handle.pause();
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
      temporalScheduleId: row.temporalScheduleId ?? scheduleId,
    },
  };
}
