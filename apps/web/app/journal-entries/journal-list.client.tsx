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
  // TODO(human): implement useQuery here.
  // Use queryKey: ["journal-entries"] and queryFn: fetchEntries.
  // Handle isLoading, error, and empty data states.
  // On empty: show "No entries yet. Your first journal will appear after your nightly call."
  // On error: show "Couldn't load entries." in red.
  // On data: render a <ul> with one <li> per entry showing entry_date and title.
  throw new Error("Not implemented — see TODO(human) above");
}
