"use client";

import Link from "next/link";
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
  if (error) return <p className="mt-8 text-red-600">Couldn&apos;t load entries.</p>;
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
        <li key={entry.id} className="rounded border border-zinc-200 hover:bg-zinc-50">
          <Link href={`/journal-entries/${entry.id}`} className="block p-3">
            <div className="text-sm text-zinc-500">{new Date(entry.entry_date).toLocaleDateString()}</div>
            <div className="font-medium">{entry.title}</div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
