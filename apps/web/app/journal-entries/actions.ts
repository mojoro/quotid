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

  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const workflowId = `journal-${userId}-manual-${ts}`;

  try {
    await client.workflow.start("JournalingWorkflow", {
      workflowId,
      taskQueue: TASK_QUEUE,
      args: [
        {
          user_id: userId,
          call_schedule_id: null,
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
