"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { IconClose } from "@/components/icons";
import { fmtDuration } from "@/lib/format";

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

export function LiveCall() {
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["call-sessions", "active"],
    queryFn: fetchActive,
    refetchInterval: 1500,
  });

  const active = data?.active ?? null;
  const phase = active?.status === "IN_PROGRESS" ? "in-progress" : active?.status === "DIALING" ? "dialing" : "off";

  const startedAt = active?.started_at ? new Date(active.started_at).getTime() : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "in-progress") return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [phase]);

  const elapsedSec = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;

  useEffect(() => {
    if (isLoading) return;
    if (phase === "off") {
      const t = setTimeout(() => router.replace("/journal-entries"), 200);
      return () => clearTimeout(t);
    }
  }, [phase, isLoading, router]);

  return (
    <div
      className="fixed inset-0 z-30 grid grid-rows-[auto_1fr_auto] px-8 pt-7 pb-9"
      style={{
        background:
          "radial-gradient(ellipse at 50% 35%, oklch(20% 0.015 60), oklch(13% 0.008 60) 70%)",
        color: "oklch(96% 0.005 80)",
        animation: "var(--animate-fade-in)",
      }}
    >
      <Head phase={phase} onMinimize={() => router.push("/journal-entries")} />
      <Center phase={phase} elapsedSec={elapsedSec} />
      <Foot
        phase={phase}
        onEnd={() => router.push("/journal-entries")}
      />
    </div>
  );
}

function Head({
  phase,
  onMinimize,
}: {
  phase: "off" | "dialing" | "in-progress";
  onMinimize: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div
          className="h-2 w-2 rounded-full"
          style={{
            background:
              phase === "in-progress"
                ? "var(--color-accent)"
                : "oklch(96% 0.005 80 / 0.6)",
          }}
          aria-hidden="true"
        />
        <div
          className="text-xs tracking-[0.16em] uppercase"
          style={{ color: "oklch(96% 0.005 80 / 0.85)" }}
        >
          {phase === "dialing" ? "Calling" : phase === "in-progress" ? "Live · End-to-end encrypted" : "Connecting"}
        </div>
      </div>
      <button
        type="button"
        onClick={onMinimize}
        className="inline-flex items-center gap-2 rounded-full border bg-transparent px-4 py-2 text-sm font-medium transition-colors"
        style={{
          borderColor: "oklch(96% 0.005 80 / 0.4)",
          color: "oklch(96% 0.005 80 / 0.95)",
        }}
      >
        Minimize
      </button>
    </div>
  );
}

function Center({
  phase,
  elapsedSec,
}: {
  phase: "off" | "dialing" | "in-progress";
  elapsedSec: number;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-4 text-center">
      <Orb phase={phase} />
      <h1 className="m-0 font-display text-[clamp(28px,3vw,32px)] font-normal tracking-[-0.02em]" style={{ color: "oklch(96% 0.005 80 / 0.96)" }}>
        Quotid
      </h1>
      <div
        className="mt-1.5 font-mono text-[12px] tracking-[0.12em] tabular-nums uppercase"
        style={{ color: "oklch(96% 0.005 80 / 0.5)" }}
      >
        {phase === "dialing"
          ? "Dialing your phone…"
          : phase === "in-progress"
          ? `Connected · ${fmtDuration(elapsedSec)}`
          : "Hanging up…"}
      </div>
    </div>
  );
}

function Orb({ phase }: { phase: "off" | "dialing" | "in-progress" }) {
  const fast = phase === "dialing";
  const ringDuration = fast ? "1.4s" : "2.8s";
  const breatheDuration = fast ? "1.6s" : "4s";

  return (
    <div
      className="relative mb-8 grid place-items-center"
      style={{ width: "clamp(100px, 22vw, 140px)", height: "clamp(100px, 22vw, 140px)" }}
    >
      <span
        aria-hidden="true"
        className="absolute rounded-full border"
        style={{
          inset: -22,
          borderColor: "oklch(96% 0.005 80 / 0.18)",
          animation: `ring ${ringDuration} ease-out infinite`,
        }}
      />
      <span
        aria-hidden="true"
        className="absolute rounded-full border"
        style={{
          inset: -44,
          borderColor: "oklch(96% 0.005 80 / 0.09)",
          animation: `ring ${ringDuration} ease-out infinite`,
          animationDelay: "0.7s",
        }}
      />
      <div
        className="h-full w-full rounded-full"
        style={{
          background:
            "radial-gradient(circle at 32% 28%, oklch(82% 0.04 55 / 0.55), transparent 45%), radial-gradient(circle at 50% 50%, var(--color-accent), oklch(38% 0.12 55) 75%)",
          boxShadow:
            "inset 0 -8px 24px oklch(25% 0.08 55 / 0.5), 0 0 60px -10px oklch(60% 0.18 55 / 0.45)",
          animation: `breathe ${breatheDuration} ease-in-out infinite`,
        }}
      />
    </div>
  );
}

function Foot({
  phase,
  onEnd,
}: {
  phase: "off" | "dialing" | "in-progress";
  onEnd: () => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-6">
      <MicMeter active={phase === "in-progress"} />
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={onEnd}
          aria-label="Hang up"
          className="inline-flex h-15 w-15 cursor-pointer items-center justify-center rounded-full border-none p-0 text-white transition-transform hover:-translate-y-0.5"
          style={{
            width: 60,
            height: 60,
            background: "var(--color-bad)",
            boxShadow: "0 8px 24px -6px oklch(58% 0.14 25 / 0.55)",
          }}
        >
          <IconClose size={26} />
        </button>
        <div
          className="font-mono text-[11px] tracking-[0.16em] uppercase"
          style={{ color: "oklch(96% 0.005 80 / 0.7)" }}
        >
          End call
        </div>
      </div>
      <div />
    </div>
  );
}

function MicMeter({ active }: { active: boolean }) {
  const [vals, setVals] = useState<number[]>(() => Array.from({ length: 24 }, () => 0.3));
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setVals(Array.from({ length: 24 }, () => 0.2 + Math.random() * 0.8));
    }, 90);
    return () => clearInterval(id);
  }, [active]);

  const bars = useMemo(() => vals, [vals]);

  return (
    <div className="flex flex-col items-start gap-2.5">
      <div className="flex h-8 items-end gap-[3px]" aria-hidden="true">
        {bars.map((v, i) => (
          <span
            key={i}
            className="w-[3px] rounded-[1px] transition-[height] duration-100"
            style={{
              height: `${v * 100}%`,
              background: "oklch(96% 0.005 80 / 0.7)",
              opacity: active ? 1 : 0.25,
            }}
          />
        ))}
      </div>
      <div
        aria-live="polite"
        className="font-mono text-[11px] tracking-[0.16em] uppercase"
        style={{ color: "oklch(96% 0.005 80 / 0.55)" }}
      >
        {active ? "Listening" : "Ringing"}
      </div>
    </div>
  );
}
