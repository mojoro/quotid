"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconArrowLeft, IconCheck, IconEdit } from "@/components/icons";
import { updateJournalEntry } from "@/app/(app)/journal-entries/actions";

type Props = {
  id: string;
  initialBody: string;
  initialTitle: string;
  eyebrow?: React.ReactNode;
};

export function EntryEditor({ id, initialBody, initialTitle, eyebrow }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(initialBody);
  const [title, setTitle] = useState(initialTitle);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    start(async () => {
      const result = await updateJournalEntry({ id, title, body });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <>
      <div className="mb-7 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => router.push("/journal-entries")}
          aria-label="Back to journal"
          className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-[10px] border border-paper-4 bg-transparent p-0 text-ink transition-colors hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          <IconArrowLeft size={18} />
        </button>
        <div className="flex gap-2">
          {!editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="Edit entry"
              className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-[10px] border border-paper-4 bg-transparent p-0 text-ink transition-colors hover:bg-paper-2"
            >
              <IconEdit size={18} />
            </button>
          ) : (
            <button
              type="button"
              onClick={save}
              disabled={pending}
              aria-label="Save entry"
              className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-[10px] border border-ink bg-ink p-0 text-paper transition-colors hover:bg-ink-2 disabled:opacity-50"
            >
              <IconCheck size={18} />
            </button>
          )}
        </div>
      </div>

      {eyebrow && <div className="font-display text-base italic text-ink-3">{eyebrow}</div>}

      {editing ? (
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Title"
          className="m-0 mt-2 w-full border-none bg-transparent font-display text-[clamp(30px,5vw,52px)] leading-[1.08] font-normal tracking-[-0.02em] outline-none focus:bg-accent-soft/30"
        />
      ) : (
        <h1 className="mt-2 font-display text-[clamp(30px,5vw,52px)] leading-[1.08] font-normal tracking-[-0.02em]">
          {title}
        </h1>
      )}

      {editing ? (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label="Entry body"
          rows={12}
          className="mt-9 w-full resize-y rounded-md border border-accent-soft bg-transparent p-2 font-display text-[17px] leading-[1.68] tracking-normal text-ink outline-none [text-wrap:pretty] focus:border-accent md:text-[19px]"
        />
      ) : (
        <article className="mt-9 font-display text-[17px] leading-[1.68] font-normal whitespace-pre-line text-ink [text-wrap:pretty] md:text-[19px]">
          {body}
        </article>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      )}
    </>
  );
}
