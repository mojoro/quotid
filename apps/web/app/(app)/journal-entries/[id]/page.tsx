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
