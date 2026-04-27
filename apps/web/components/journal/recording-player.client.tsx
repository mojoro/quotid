"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconPause, IconPlay } from "@/components/icons";
import { fmtDuration } from "@/lib/format";

type Props = {
  src: string;
  initialDuration?: number | null;
};

export function RecordingPlayer({ src, initialDuration }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [duration, setDuration] = useState(initialDuration ?? 0);
  const [error, setError] = useState(false);

  const bars = useMemo(() => {
    const N = 56;
    const seed = duration || 60;
    const arr: number[] = [];
    for (let i = 0; i < N; i++) {
      const v =
        (Math.sin(i * 1.3 + seed) * 0.5 + 0.5) * 0.7 +
        0.18 * Math.abs(Math.sin(i * 0.6));
      arr.push(Math.min(1, Math.max(0.18, v)));
    }
    return arr;
  }, [duration]);

  const playedFraction = duration ? Math.min(1, pos / duration) : 0;
  const playedIdx = Math.floor(playedFraction * bars.length);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setPos(audio.currentTime);
    const onMeta = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onEnded = () => {
      setPlaying(false);
      setPos(0);
    };
    const onError = () => setError(true);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, []);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().then(() => setPlaying(true)).catch(() => setError(true));
    }
  }

  function seekFromEvent(e: React.PointerEvent | PointerEvent) {
    const node = waveRef.current;
    const audio = audioRef.current;
    if (!node || !audio) return;
    const r = node.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const target = duration * f;
    audio.currentTime = target;
    setPos(target);
  }

  return (
    <div
      role="region"
      aria-label="Recording playback"
      className="mt-9 grid grid-cols-[auto_1fr_auto] [grid-template-areas:'btn_wave_time'] items-center gap-4 rounded-[18px] border border-paper-3 bg-paper-2 px-4.5 py-4 max-md:grid-cols-[auto_1fr] max-md:[grid-template-areas:'btn_wave''time_time'] max-md:gap-y-2.5"
    >
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={toggle}
        disabled={error}
        aria-label={playing ? "Pause recording" : "Play recording"}
        className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-ink p-0 text-paper transition-all hover:bg-ink-2 active:scale-[0.96] disabled:opacity-40 max-md:h-10 max-md:w-10 [grid-area:btn]"
      >
        {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
      </button>
      <div
        ref={waveRef}
        role="slider"
        tabIndex={0}
        aria-label="Seek within recording"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={pos}
        aria-valuetext={`${fmtDuration(Math.floor(pos))} of ${fmtDuration(Math.floor(duration))}`}
        onPointerDown={(e) => {
          draggingRef.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          seekFromEvent(e);
        }}
        onPointerMove={(e) => draggingRef.current && seekFromEvent(e)}
        onPointerUp={() => (draggingRef.current = false)}
        onPointerCancel={() => (draggingRef.current = false)}
        onKeyDown={(e) => {
          const audio = audioRef.current;
          if (!audio) return;
          if (e.key === "ArrowRight") {
            e.preventDefault();
            audio.currentTime = Math.min(duration, audio.currentTime + 5);
          }
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            audio.currentTime = Math.max(0, audio.currentTime - 5);
          }
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            toggle();
          }
        }}
        className="relative flex h-10 min-w-0 cursor-pointer touch-none items-center gap-0.5 overflow-hidden outline-none focus-visible:rounded focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-4 max-md:h-9 [grid-area:wave]"
      >
        {bars.map((h, i) => (
          <span
            key={i}
            className={`pointer-events-none min-w-0 flex-1 rounded-[1px] transition-colors duration-75 ${
              i < playedIdx ? "bg-accent" : "bg-ink-4"
            }`}
            style={{ height: `${Math.round(h * 100)}%` }}
          />
        ))}
      </div>
      <div className="shrink-0 text-xs tabular-nums text-ink-3 max-md:text-right max-md:text-[11px] [grid-area:time]">
        {fmtDuration(Math.floor(pos))} / {fmtDuration(Math.floor(duration))}
      </div>
    </div>
  );
}
