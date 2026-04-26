"use client";

import { useState, useTransition } from "react";
import { updateCallSchedule } from "./actions";

type Props = {
  initialEnabled: boolean;
  initialTime: string;
  timezone: string;
};

export function ScheduleForm({ initialEnabled, initialTime, timezone }: Props) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [time, setTime] = useState(initialTime);
  const [pending, start] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [hh, mm] = time.split(":");

  function setHM(h: string, m: string) {
    const newH = String(Math.max(0, Math.min(23, Number(h) || 0))).padStart(2, "0");
    const newM = String(Math.max(0, Math.min(59, Number(m) || 0))).padStart(2, "0");
    const next = `${newH}:${newM}`;
    setTime(next);
    save(enabled, next);
  }

  function save(nextEnabled: boolean, nextTime: string) {
    setError(null);
    start(async () => {
      const result = await updateCallSchedule({
        localTimeOfDay: nextTime,
        enabled: nextEnabled,
      });
      if (!result.ok) setError(result.error);
      else setSavedAt(Date.now());
    });
  }

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    save(next, time);
  }

  return (
    <>
      <Row
        label="Auto-call"
        hint="When on, we'll call you every day at your chosen time."
      >
        <Toggle on={enabled} onClick={toggle} ariaLabel="Auto-call" />
      </Row>

      <Row
        label="Time of day"
        hint="Pick a time you're usually winding down. We're best at the boundary between day and sleep."
      >
        <div className="inline-flex items-center gap-1.5 rounded-[10px] border border-paper-3 bg-paper-2 px-3.5 py-2.5 font-display text-[22px] tabular-nums text-ink">
          <input
            type="number"
            min={0}
            max={23}
            value={hh}
            onChange={(e) => setHM(e.target.value, mm)}
            aria-label="Hour"
            className="w-[1.8em] border-none bg-transparent text-center font-inherit text-inherit text-current outline-none [appearance:textfield] [-moz-appearance:textfield] focus:rounded focus:bg-accent-soft [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span aria-hidden="true">:</span>
          <input
            type="number"
            min={0}
            max={59}
            value={mm}
            onChange={(e) => setHM(hh, e.target.value)}
            aria-label="Minute"
            className="w-[1.8em] border-none bg-transparent text-center font-inherit text-inherit text-current outline-none [appearance:textfield] [-moz-appearance:textfield] focus:rounded focus:bg-accent-soft [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
        </div>
        <div className="mt-2 text-[13px] leading-[1.5] text-ink-3">
          {timezone} (your account time zone)
        </div>
      </Row>

      <Row
        label="Days"
        hint="Skip days you'd rather not be interrupted. (Backend stores a single daily schedule for now — every day is on.)"
      >
        <DayPickerStub />
      </Row>

      <div className="mt-3 min-h-5 text-[12px]">
        {pending && <span className="text-ink-3">Saving…</span>}
        {!pending && savedAt && !error && (
          <span className="text-good">Saved.</span>
        )}
        {error && (
          <span role="alert" className="text-bad">
            {error}
          </span>
        )}
      </div>
    </>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-2.5 border-b border-paper-3 py-4.5 last-of-type:border-b-0 md:grid-cols-[220px_1fr] md:gap-8 md:py-5.5">
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        {hint && <div className="mt-1 text-[13px] leading-[1.5] text-ink-3">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({
  on,
  onClick,
  ariaLabel,
}: {
  on: boolean;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onClick}
      className={`relative h-6 w-11 rounded-full border-none transition-colors ${
        on ? "bg-accent" : "bg-paper-4"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_oklch(0%_0_0_/_0.2)] transition-transform ${
          on ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function DayPickerStub() {
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {days.map((d, i) => (
        <span
          key={i}
          className="grid h-9 w-9 cursor-not-allowed place-items-center rounded-full border border-ink bg-ink text-[12px] font-medium text-paper opacity-60"
          title="Backend stores a daily schedule only — every day is on"
        >
          {d}
        </span>
      ))}
    </div>
  );
}

export function VoicePickerStub() {
  return (
    <div className="flex flex-col gap-2">
      {[
        { id: "asteria", name: "Asteria", desc: "Warm, mid-range, evening" },
        { id: "orion", name: "Orion", desc: "Lower, slower, contemplative" },
      ].map((v, i) => {
        const selected = i === 0;
        return (
          <div
            key={v.id}
            className={`grid grid-cols-[auto_1fr_auto] items-center gap-3.5 rounded-xl border bg-paper-2 px-3.5 py-3 text-left ${
              selected
                ? "border-accent shadow-[0_0_0_6px_oklch(62%_0.16_55_/_0.10)]"
                : "border-paper-3"
            }`}
          >
            <div className="grid h-9 w-9 place-items-center rounded-full bg-ink text-paper text-[11px]">
              {v.name[0]}
            </div>
            <div>
              <div className="font-display text-[17px] tracking-[-0.01em]">{v.name}</div>
              <div className="mt-0.5 text-xs text-ink-3 italic">{v.desc}</div>
            </div>
            <span
              className={`grid h-5.5 w-5.5 place-items-center rounded-full text-[12px] ${
                selected
                  ? "border-accent bg-accent text-white"
                  : "border-1.5 border-paper-4 text-transparent"
              }`}
            >
              ✓
            </span>
          </div>
        );
      })}
      <p className="mt-1 text-[12px] text-ink-3 italic">
        Backend doesn&apos;t store a voice preference yet — Pipecat hardcodes
        the voice. Picker is illustrative.
      </p>
    </div>
  );
}
