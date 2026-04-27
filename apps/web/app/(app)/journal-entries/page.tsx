import Link from "next/link";
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { prisma } from "@/lib/db";
import { currentUserId } from "@/lib/auth";
import { StatusCard } from "@/components/journal/status-card.client";
import { fmtDuration, fmtMonth, fmtTimeOfDay } from "@/lib/format";

type FeedItem = {
  id: string;
  entryDate: string;
  ts: number;
  timeOfDay: string;
  title: string;
  isEdited: boolean;
  durationSeconds: number | null;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default async function JournalPage() {
  const userId = await currentUserId();

  const [user, schedule, entries] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, phoneNumber: true, timezone: true },
    }),
    prisma.callSchedule.findUnique({
      where: { userId },
      select: { enabled: true, localTimeOfDay: true },
    }),
    prisma.journalEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { callSession: { select: { durationSeconds: true } } },
    }),
  ]);

  if (!user) return null;

  const feed: FeedItem[] = entries
    .map<FeedItem>((e) => ({
      id: e.id,
      entryDate: isoDate(e.entryDate),
      ts: e.createdAt.getTime(),
      timeOfDay: fmtTimeOfDay(e.createdAt),
      title: e.title,
      isEdited: e.isEdited,
      durationSeconds: e.callSession?.durationSeconds ?? null,
    }))
    .sort((a, b) => b.ts - a.ts);

  const groups = new Map<string, FeedItem[]>();
  for (const item of feed) {
    const key = fmtMonth(item.entryDate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  const queryClient = new QueryClient();
  await queryClient.prefetchQuery({
    queryKey: ["call-sessions", "active"],
    queryFn: async () => ({ active: null }),
  });

  const greetingName = user.email.split("@")[0].split(/[._-]/)[0];
  const greetingNameDisplay =
    greetingName.charAt(0).toUpperCase() + greetingName.slice(1);

  return (
    <div style={{ animation: "var(--animate-route-in)" }}>
      <div className="text-[11px] font-medium tracking-[0.16em] text-ink-3 uppercase">
        {greeting()}, {greetingNameDisplay}
      </div>
      <h1 className="mt-2 font-display text-[clamp(32px,4.4vw,56px)] leading-[1.05] font-normal tracking-[-0.025em]">
        Your <em className="text-accent-ink">journal</em>, born from conversation.
      </h1>

      <HydrationBoundary state={dehydrate(queryClient)}>
        <StatusCard
          schedule={schedule}
          phoneNumber={user.phoneNumber}
          timezone={user.timezone}
        />
      </HydrationBoundary>

      {feed.length === 0 ? (
        <p className="mt-12 font-display text-lg italic text-ink-3">
          Your journal will fill in here, one evening at a time.
        </p>
      ) : (
        Array.from(groups.entries()).map(([month, items]) => (
          <section
            key={month}
            className="mt-12 grid grid-cols-1 gap-1.5 md:grid-cols-[80px_1fr] md:gap-7"
          >
            <div className="self-start pt-3 font-display text-[14px] italic text-ink-3 md:sticky md:top-6 md:text-[18px]">
              {month}
            </div>
            <div className="flex flex-col">
              {items.map((item, i) => {
                const prev = items[i - 1];
                const next = items[i + 1];
                const isCont = prev?.entryDate === item.entryDate;
                const hasCont = next?.entryDate === item.entryDate;

                return (
                  <EntryRow
                    key={item.id}
                    item={item}
                    isCont={isCont}
                    hasCont={hasCont}
                  />
                );
              })}
            </div>
          </section>
        ))
      )}

      <div className="h-20" />
    </div>
  );
}

function DayCell({
  isCont,
  hasCont,
  date,
  timeOfDay,
}: {
  isCont: boolean;
  hasCont: boolean;
  date: string;
  timeOfDay: string;
}) {
  if (isCont) {
    return (
      <div className="relative pl-3.5 font-display text-[22px] tracking-[-0.02em] text-ink-2 [font-feature-settings:'lnum'] md:text-[28px]">
        <span
          className="absolute top-[-10px] bottom-[-10px] left-1 w-px bg-paper-4"
          aria-hidden="true"
        />
        <span
          className="absolute top-3 left-1 h-px w-2 bg-paper-4"
          aria-hidden="true"
        />
        <div className="font-mono text-[11px] tracking-[0.04em] text-ink-4">
          {timeOfDay || "—"}
        </div>
      </div>
    );
  }

  const day = new Date(date).getDate();
  return (
    <div className="font-display text-[22px] tracking-[-0.02em] text-ink-2 [font-feature-settings:'lnum'] md:text-[28px]">
      {day}
      {hasCont && (
        <div className="mt-1 font-mono text-[11px] tracking-[0.04em] text-ink-4">
          {timeOfDay || ""}
        </div>
      )}
    </div>
  );
}

function EntryRow({
  item,
  isCont,
  hasCont,
}: {
  item: FeedItem;
  isCont: boolean;
  hasCont: boolean;
}) {
  const weekday = new Date(item.entryDate).toLocaleString(undefined, {
    weekday: "short",
  });
  return (
    <Link
      href={`/journal-entries/${item.id}`}
      className={`grid w-full cursor-pointer grid-cols-[48px_1fr_auto] items-baseline gap-3 px-0.5 py-3.5 text-left text-inherit no-underline transition-colors hover:bg-paper-2 md:grid-cols-[56px_1fr_auto] md:gap-4.5 md:px-1 md:py-4.5 ${
        hasCont ? "border-b border-transparent" : "border-b border-paper-3"
      }`}
    >
      <DayCell
        isCont={isCont}
        hasCont={hasCont}
        date={item.entryDate}
        timeOfDay={item.timeOfDay}
      />
      <div>
        <div className="font-display text-[16px] leading-[1.3] tracking-[-0.01em] text-ink md:text-[19px]">
          {item.title}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[13px] text-ink-3">
          <span className="text-xs text-ink-3">
            {fmtDuration(item.durationSeconds)} call
          </span>
          {item.isEdited && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-paper-4 bg-transparent px-2 py-0.5 text-[11px] tracking-[0.04em] text-ink-4">
              edited
            </span>
          )}
        </div>
      </div>
      <div className="text-xs tabular-nums text-ink-4">
        {isCont ? "" : weekday}
      </div>
    </Link>
  );
}

