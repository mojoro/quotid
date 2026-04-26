"use server";

import { revalidatePath } from "next/cache";
import { currentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getTemporalClient, TASK_QUEUE } from "@/lib/temporal-client";

export type TriggerCallResult =
  | { ok: true; workflowId: string }
  | { ok: false; error: string };

export type UpdateJournalEntryInput = {
  id: string;
  title?: string;
  body?: string;
};

export type UpdateJournalEntryResult =
  | {
      ok: true;
      entry: {
        id: string;
        title: string;
        body: string;
        isEdited: boolean;
      };
    }
  | { ok: false; error: string };

export async function updateJournalEntry(
  input: UpdateJournalEntryInput,
): Promise<UpdateJournalEntryResult> {
  const userId = await currentUserId();

  const existing = await prisma.journalEntry.findFirst({
    where: { id: input.id, userId },
    select: { id: true, generatedBody: true },
  });
  if (!existing) return { ok: false, error: "not found" };

  const trimmedTitle = input.title?.trim();
  if (input.title !== undefined && !trimmedTitle) {
    return { ok: false, error: "title cannot be empty" };
  }

  const data: { title?: string; body?: string; isEdited?: boolean } = {};
  if (trimmedTitle !== undefined) data.title = trimmedTitle;
  if (input.body !== undefined) {
    data.body = input.body;
    data.isEdited = input.body !== existing.generatedBody;
  }

  const updated = await prisma.journalEntry.update({
    where: { id: existing.id },
    data,
    select: { id: true, title: true, body: true, isEdited: true },
  });

  revalidatePath("/journal-entries");
  revalidatePath(`/journal-entries/${updated.id}`);

  return { ok: true, entry: updated };
}

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
