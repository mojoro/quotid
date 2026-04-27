export function fmtDuration(s: number | null | undefined): string {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

// All format helpers below take an optional `tz` so the journal can render
// dates and times in the user's timezone (loaded from `User.timezone`)
// rather than the server's UTC. Without `tz` they fall back to whatever
// runtime locale is active (browser tz on the client; UTC in the docker
// container on the server).

export function fmtMonth(date: Date | string, tz?: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(undefined, { month: "long", year: "numeric", timeZone: tz });
}

export function fmtDay(date: Date | string, tz?: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (!tz) return String(d.getDate());
  return d.toLocaleString(undefined, { day: "numeric", timeZone: tz });
}

export function fmtLong(date: Date | string, tz?: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
}

export function fmtTimeOfDay(date: Date | string, tz?: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  });
}

export function fmtWeekday(date: Date | string, tz?: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(undefined, { weekday: "short", timeZone: tz });
}

// ISO-style YYYY-MM-DD in the given timezone. Used for grouping entries
// by "the same day" — must respect the user's tz, otherwise an entry made
// at 23:30 local time can collide with the next day depending on UTC offset.
export function isoDateInTz(date: Date | string, tz?: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (!tz) return d.toISOString().slice(0, 10);
  // en-CA produces YYYY-MM-DD which matches our ISO grouping convention.
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

export function fmtMsAsTime(ms: number | null | undefined): string {
  if (ms == null) return "";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = String(totalSec % 60).padStart(2, "0");
  return `${String(m).padStart(2, "0")}:${s}`;
}
