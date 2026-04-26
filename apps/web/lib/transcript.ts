import { fmtMsAsTime } from "@/lib/format";

export type Turn = {
  who: "bot" | "user";
  text: string;
  t: string;
};

type Segment = {
  speaker?: string;
  text?: string;
  start_ms?: number | null;
};

export function segmentsToTurns(segments: Segment[] | null | undefined): Turn[] {
  if (!segments || !Array.isArray(segments)) return [];
  return segments
    .filter((s) => s && typeof s.text === "string" && s.text.length > 0)
    .map((s) => ({
      who: s.speaker === "assistant" ? ("bot" as const) : ("user" as const),
      text: s.text!,
      t: fmtMsAsTime(s.start_ms ?? null),
    }));
}
