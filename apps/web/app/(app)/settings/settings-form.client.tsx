"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  updateCallSchedule,
  updateProfile,
  updateVoicePreference,
} from "./actions";
import { AVAILABLE_VOICES } from "./voices";

const COMMON_TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type SaveStatus = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; msg: string };

function StatusLine({ status }: { status: SaveStatus }) {
  return (
    <div className="mt-3 min-h-5 text-[12px]">
      {status.kind === "saving" && <span className="text-ink-3">Saving…</span>}
      {status.kind === "saved" && <span className="text-good">Saved.</span>}
      {status.kind === "error" && (
        <span role="alert" className="text-bad">
          {status.msg}
        </span>
      )}
    </div>
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

function inputCls() {
  return "w-full rounded-[10px] border border-paper-4 bg-paper-2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:bg-paper";
}

// ─── Profile (name + phone + timezone) ────────────────────────────────────

type ProfileProps = {
  initialName: string | null;
  initialPhone: string;
  initialTimezone: string;
};

export function ProfileForm({ initialName, initialPhone, initialTimezone }: ProfileProps) {
  const [name, setName] = useState(initialName ?? "");
  const [phone, setPhone] = useState(initialPhone);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  function commit(next: Partial<{ name: string; phone: string; timezone: string }>) {
    const payload = {
      name: (next.name ?? name).trim() || null,
      phoneNumber: (next.phone ?? phone).trim(),
      timezone: next.timezone ?? timezone,
    };
    setStatus({ kind: "saving" });
    start(async () => {
      const result = await updateProfile(payload);
      if (!result.ok) setStatus({ kind: "error", msg: result.error });
      else setStatus({ kind: "saved" });
    });
  }

  // Includes the user's IANA tz even if it's not in the curated list.
  const tzOptions = Array.from(new Set([initialTimezone, ...COMMON_TIMEZONES])).sort();

  return (
    <>
      <Row label="Name" hint="Used in greetings and on the journal page.">
        <input
          type="text"
          value={name}
          maxLength={80}
          placeholder="Your name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if ((name.trim() || null) !== (initialName ?? null)) commit({ name });
          }}
          className={inputCls()}
        />
      </Row>

      <Row
        label="Phone number"
        hint="The number Quotid will call. Include country code (E.164, e.g. +14155551234)."
      >
        <input
          type="tel"
          value={phone}
          inputMode="tel"
          autoComplete="tel"
          onChange={(e) => setPhone(e.target.value)}
          onBlur={() => {
            if (phone !== initialPhone) commit({ phone });
          }}
          className={inputCls()}
        />
      </Row>

      <Row
        label="Time zone"
        hint="We'll schedule calls in this zone. Defaults to your account zone."
      >
        <select
          value={timezone}
          onChange={(e) => {
            const next = e.target.value;
            setTimezone(next);
            if (next !== initialTimezone) commit({ timezone: next });
          }}
          className={inputCls()}
        >
          {tzOptions.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </Row>

      <StatusLine status={pending ? { kind: "saving" } : status} />
    </>
  );
}

// ─── Schedule (auto-call + time + days) ───────────────────────────────────

type ScheduleProps = {
  initialEnabled: boolean;
  initialTime: string;
  initialDaysOfWeek: number;
  timezone: string;
};

export function ScheduleForm({
  initialEnabled,
  initialTime,
  initialDaysOfWeek,
  timezone,
}: ScheduleProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [time, setTime] = useState(initialTime);
  const [daysMask, setDaysMask] = useState(initialDaysOfWeek);
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  const [hh, mm] = time.split(":");

  function save(nextEnabled: boolean, nextTime: string, nextDays: number) {
    setStatus({ kind: "saving" });
    start(async () => {
      const result = await updateCallSchedule({
        localTimeOfDay: nextTime,
        enabled: nextEnabled,
        daysOfWeek: nextDays,
      });
      if (!result.ok) setStatus({ kind: "error", msg: result.error });
      else setStatus({ kind: "saved" });
    });
  }

  function setHM(h: string, m: string) {
    const newH = String(Math.max(0, Math.min(23, Number(h) || 0))).padStart(2, "0");
    const newM = String(Math.max(0, Math.min(59, Number(m) || 0))).padStart(2, "0");
    const next = `${newH}:${newM}`;
    setTime(next);
    save(enabled, next, daysMask);
  }

  function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    save(next, time, daysMask);
  }

  function toggleDay(idx: number) {
    const next = daysMask ^ (1 << idx);
    setDaysMask(next);
    save(enabled, time, next);
  }

  return (
    <>
      <Row label="Auto-call" hint="When on, we'll call you at your chosen time on the days you pick.">
        <Toggle on={enabled} onClick={toggleEnabled} ariaLabel="Auto-call" />
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

      <Row label="Days" hint="Tap a day to skip it.">
        <div className="mt-2 flex flex-wrap gap-1.5">
          {DAY_LABELS.map((d, i) => {
            const on = (daysMask & (1 << i)) !== 0;
            return (
              <button
                key={i}
                type="button"
                onClick={() => toggleDay(i)}
                aria-pressed={on}
                aria-label={DAY_NAMES[i]}
                title={DAY_NAMES[i]}
                className={`grid h-9 w-9 cursor-pointer place-items-center rounded-full border text-[12px] font-medium transition-colors ${
                  on
                    ? "border-ink bg-ink text-paper"
                    : "border-paper-3 bg-paper-2 text-ink-3 hover:border-paper-4"
                }`}
              >
                {d}
              </button>
            );
          })}
        </div>
        {daysMask === 0 && enabled && (
          <div className="mt-2 text-[12px] text-ink-3 italic">
            No days selected — schedule is paused.
          </div>
        )}
      </Row>

      <StatusLine status={pending ? { kind: "saving" } : status} />
    </>
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

// ─── Voice picker (real previews + persistence) ──────────────────────────

export function VoicePicker({ initial }: { initial: string }) {
  const [selected, setSelected] = useState(initial);
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => audioRef.current?.pause(), []);

  function pick(id: string) {
    if (id === selected) return;
    setSelected(id);
    setStatus({ kind: "saving" });
    start(async () => {
      const result = await updateVoicePreference(id);
      if (!result.ok) setStatus({ kind: "error", msg: result.error });
      else setStatus({ kind: "saved" });
    });
  }

  function preview(id: string) {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (previewing === id) {
      setPreviewing(null);
      return;
    }
    const audio = new Audio(`/api/voice-preview?voice=${encodeURIComponent(id)}`);
    audio.addEventListener("ended", () => setPreviewing((s) => (s === id ? null : s)));
    audio.addEventListener("error", () => setPreviewing((s) => (s === id ? null : s)));
    audioRef.current = audio;
    setPreviewing(id);
    audio.play().catch(() => setPreviewing(null));
  }

  return (
    <div className="flex flex-col gap-2">
      {AVAILABLE_VOICES.map((v) => {
        const isSelected = v.id === selected;
        const isPlaying = previewing === v.id;
        return (
          <div
            key={v.id}
            className={`grid grid-cols-[auto_1fr_auto_auto] items-center gap-3.5 rounded-xl border bg-paper-2 px-3.5 py-3 text-left ${
              isSelected
                ? "border-accent shadow-[0_0_0_6px_oklch(62%_0.16_55_/_0.10)]"
                : "border-paper-3"
            }`}
          >
            <div className="grid h-9 w-9 place-items-center rounded-full bg-ink text-paper text-[11px]">
              {v.name[0]}
            </div>
            <button
              type="button"
              onClick={() => pick(v.id)}
              className="cursor-pointer border-none bg-transparent text-left p-0"
            >
              <div className="font-display text-[17px] tracking-[-0.01em]">{v.name}</div>
              <div className="mt-0.5 text-xs text-ink-3 italic">{v.desc}</div>
            </button>
            <button
              type="button"
              onClick={() => preview(v.id)}
              aria-label={isPlaying ? `Stop ${v.name} preview` : `Preview ${v.name}`}
              className="rounded-full border border-paper-3 bg-transparent px-3 py-1.5 text-[12px] text-ink-2 hover:bg-paper-3 cursor-pointer"
            >
              {isPlaying ? "Stop" : "Preview"}
            </button>
            <span
              aria-hidden="true"
              className={`grid h-5.5 w-5.5 place-items-center rounded-full text-[12px] ${
                isSelected
                  ? "border-accent bg-accent text-white"
                  : "border-1.5 border-paper-4 text-transparent"
              }`}
            >
              ✓
            </span>
          </div>
        );
      })}
      <StatusLine status={pending ? { kind: "saving" } : status} />
    </div>
  );
}
