"use client";

import { useTransition } from "react";
import { useQuery } from "@tanstack/react-query";
import { triggerCall } from "@/app/(app)/journal-entries/actions";
import { useRouter } from "next/navigation";

type ActiveCall = {
  id: string;
  status: "DIALING" | "IN_PROGRESS";
  scheduled_for: string;
  started_at: string | null;
  workflow_id: string;
} | null;

type ActiveResponse = { active: ActiveCall };

async function fetchActive(): Promise<ActiveResponse> {
  const res = await fetch("/api/call-sessions/active", { credentials: "include" });
  if (!res.ok) throw new Error(`Active call fetch failed: ${res.status}`);
  return res.json();
}

type Props = {
  schedule: {
    enabled: boolean;
    localTimeOfDay: string;
  } | null;
  phoneNumber: string;
  timezone: string;
};

export function StatusCard({ schedule, phoneNumber, timezone }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { data } = useQuery({
    queryKey: ["call-sessions", "active"],
    queryFn: fetchActive,
    refetchInterval: (q) => (q.state.data?.active ? 2000 : 8000),
    staleTime: 0,
  });

  const active = data?.active ?? null;
  const isLive = active?.status === "IN_PROGRESS" || active?.status === "DIALING";

  function onTrigger() {
    start(async () => {
      await triggerCall();
    });
  }

  if (isLive && active) {
    const dialing = active.status === "DIALING";
    return (
      <div
        className="mt-7 grid grid-cols-1 items-center gap-4 rounded-[18px] border border-accent-soft p-4 px-5 sm:grid-cols-[1fr_auto] sm:gap-x-6 sm:p-5.5 sm:px-6"
        style={{
          background: "linear-gradient(180deg, var(--color-accent-soft), var(--color-paper-2))",
        }}
      >
        <div>
          <div className="flex items-center gap-2.5 text-[11px] tracking-[0.16em] text-ink-3 uppercase">
            <span
              className="inline-block h-2 w-2 rounded-full bg-accent"
              style={{ animation: "var(--animate-pulse-ring)" }}
              aria-hidden="true"
            />
            {dialing ? "Calling you…" : "On the call"}
          </div>
          <div className="mt-1.5 font-display text-2xl tracking-[-0.01em]">
            {dialing ? "Your phone should ring in a moment" : "Tonight's check-in is happening"}
          </div>
          <div className="mt-2 text-sm text-ink-3">
            {phoneNumber} · Pick up when you're ready
          </div>
        </div>
        <button
          type="button"
          onClick={() => router.push(`/call?id=${active.id}`)}
          className="inline-flex items-center gap-2 self-start justify-self-start rounded-full border border-transparent bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-[oklch(from_var(--color-accent)_calc(l-0.04)_c_h)] active:scale-[0.98] sm:self-center sm:justify-self-end"
        >
          Open call →
        </button>
      </div>
    );
  }

  const enabled = schedule?.enabled ?? false;
  const time = schedule?.localTimeOfDay ?? "21:00";

  return (
    <div className="mt-7 grid grid-cols-1 items-center gap-4 rounded-[18px] border border-paper-3 bg-paper-2 p-4 px-5 sm:grid-cols-[1fr_auto] sm:gap-x-6 sm:p-5.5 sm:px-6">
      <div>
        <div className="text-[11px] tracking-[0.16em] text-ink-3 uppercase">Tonight</div>
        <div className="mt-1.5 font-display text-2xl tracking-[-0.01em]">
          {enabled ? `Quotid will call you at ${time}` : "Auto-call is paused"}
        </div>
        <div className="mt-2 text-sm text-ink-3">
          {enabled
            ? `${phoneNumber} · ${timezone}`
            : "Turn it back on in Settings, or call now whenever you want."}
        </div>
      </div>
      <button
        type="button"
        onClick={onTrigger}
        disabled={pending}
        className="inline-flex items-center gap-2 self-start justify-self-start rounded-full border border-transparent bg-ink px-4 py-2.5 text-sm font-medium text-paper transition-all hover:bg-ink-2 active:scale-[0.98] disabled:opacity-50 sm:self-center sm:justify-self-end"
      >
        {pending ? "Starting…" : "Call me now"}
      </button>
    </div>
  );
}
