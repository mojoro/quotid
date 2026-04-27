"use client";

import { useState } from "react";
import type { Turn } from "@/lib/transcript";

type Props = {
  turns: Turn[];
  userLabel: string;
};

export function Transcript({ turns, userLabel }: Props) {
  const [open, setOpen] = useState(false);
  if (turns.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="mt-7 inline-flex items-center gap-2 rounded-full border border-paper-3 bg-transparent px-3.5 py-2.5 text-[13px] text-ink-2 transition-colors hover:bg-paper-2"
      >
        {open ? "Hide transcript" : `View transcript · ${turns.length} turns`}
      </button>
      {open && (
        <div className="mt-4 rounded-[18px] border border-paper-3 bg-paper-2 p-6 max-md:p-4 max-md:break-words">
          {turns.map((turn, i) => (
            <div
              key={i}
              className="grid grid-cols-[70px_1fr] gap-3.5 py-2.5 max-md:grid-cols-1 max-md:gap-1"
            >
              <div
                className={`pt-1.5 text-[11px] tracking-[0.1em] uppercase ${
                  turn.who === "bot" ? "text-accent-ink" : "text-ink-3"
                }`}
              >
                {turn.who === "bot" ? "Quotid" : userLabel}
              </div>
              <div className="text-[15px] leading-[1.6] break-words text-ink max-md:[overflow-wrap:anywhere]">
                {turn.text}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

