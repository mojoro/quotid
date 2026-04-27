"use client";

import { useState } from "react";
import Link from "next/link";
import { fmtDuration } from "@/lib/format";

type Status = "PENDING" | "DIALING" | "IN_PROGRESS" | "COMPLETED" | "NO_ANSWER" | "FAILED" | "CANCELLED";

type Item = {
  id: string;
  scheduledFor: string;
  startedAt: string | null;
  status: Status;
  durationSeconds: number | null;
  failureReason: string | null;
  entryId: string | null;
  entryTitle: string | null;
};

type Filter = "all" | "completed" | "missed" | "failed";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed" },
  { id: "missed", label: "Missed" },
  { id: "failed", label: "Failed" },
];

function matchesFilter(item: Item, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "completed") return item.status === "COMPLETED";
  if (f === "missed") return item.status === "NO_ANSWER";
  if (f === "failed") return item.status === "FAILED" || item.status === "CANCELLED";
  return true;
}

export function CallsListClient({
  items,
  timezone,
}: {
  items: Item[];
  timezone: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = items.filter((i) => matchesFilter(i, filter));

  return (
    <>
      <div className="mt-7 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-full px-3.5 py-1.5 text-[13px] transition-colors ${
                active
                  ? "bg-accent-soft text-accent-ink"
                  : "border border-paper-3 bg-transparent text-ink-2 hover:bg-paper-2"
              }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <div className="mt-9">
        {visible.length === 0 ? (
          <p className="mt-12 font-display text-lg italic text-ink-3">
            No calls match this filter.
          </p>
        ) : (
          visible.map((item) => (
            <CallRow key={item.id} item={item} timezone={timezone} />
          ))
        )}
      </div>
    </>
  );
}

function CallRow({ item, timezone }: { item: Item; timezone: string }) {
  // Prefer the actual call start when we have it. `scheduledFor` can be epoch
  // for older Schedule-fired calls (the workflow now substitutes a real time
  // before writing, but legacy rows aren't backfilled in code).
  const date = new Date(item.startedAt ?? item.scheduledFor);
  const dateLabel = date.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
    timeZone: timezone,
  });
  const timeLabel = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  });

  const title =
    item.status === "COMPLETED" && item.entryTitle
      ? item.entryTitle
      : <span className="text-ink-3">No journal entry</span>;

  let sub: string | null = null;
  if (item.status === "COMPLETED") sub = "Completed · transcript available";
  else if (item.status === "NO_ANSWER")
    sub = `No answer${item.failureReason ? ` · ${item.failureReason}` : ""}`;
  else if (item.status === "FAILED")
    sub = `Failed${item.failureReason ? ` · ${item.failureReason}` : ""}`;
  else if (item.status === "DIALING") sub = "Dialing…";
  else if (item.status === "IN_PROGRESS") sub = "In progress";
  else if (item.status === "PENDING") sub = "Pending";
  else if (item.status === "CANCELLED") sub = "Cancelled";

  let statusPill: { label: string; className: string };
  if (item.status === "COMPLETED") {
    statusPill = {
      label: "completed",
      className: "bg-paper-3 text-ink-3",
    };
  } else if (item.status === "NO_ANSWER") {
    statusPill = {
      label: "missed",
      className: "bg-cool-soft text-cool",
    };
  } else if (item.status === "FAILED" || item.status === "CANCELLED") {
    statusPill = {
      label: "failed",
      className: "bg-cool-soft text-cool",
    };
  } else {
    statusPill = {
      label: item.status.toLowerCase(),
      className: "bg-accent-soft text-accent-ink",
    };
  }

  const inner = (
    <div className="grid w-full grid-cols-[70px_1fr_auto] items-center gap-3 border-b border-paper-3 px-1 py-3.5 text-left text-inherit transition-colors hover:bg-paper-2 md:grid-cols-[100px_1fr_auto_auto] md:gap-4.5">
      <div className="font-mono text-xs text-ink-3">
        {dateLabel}
        <div className="mt-0.5 text-ink-4">{timeLabel}</div>
      </div>
      <div className="text-[14px] text-ink">
        {title}
        {sub && (
          <small className="mt-0.5 block text-xs text-ink-3">{sub}</small>
        )}
      </div>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] tracking-[0.04em] ${statusPill.className}`}
      >
        {statusPill.label}
      </span>
      <div className="hidden font-mono text-xs text-ink-3 md:block">
        {fmtDuration(item.durationSeconds)}
      </div>
    </div>
  );

  if (item.entryId) {
    return (
      <Link href={`/journal-entries/${item.entryId}`} className="block">
        {inner}
      </Link>
    );
  }
  return <div>{inner}</div>;
}
