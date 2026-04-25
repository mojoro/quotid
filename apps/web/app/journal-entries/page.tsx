import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { prisma } from "@/lib/db";
import { currentUserId } from "@/lib/auth";
import { JournalList } from "./journal-list.client";

export default async function JournalEntriesPage() {
  const userId = await currentUserId();
  const queryClient = new QueryClient();

  await queryClient.prefetchQuery({
    queryKey: ["journal-entries"],
    queryFn: async () => {
      const entries = await prisma.journalEntry.findMany({
        where: { userId },
        orderBy: { entryDate: "desc" },
        take: 50,
        select: { id: true, title: true, entryDate: true, createdAt: true },
      });
      return entries.map((e) => ({
        id: e.id,
        title: e.title,
        entry_date: e.entryDate.toISOString(),
        created_at: e.createdAt.toISOString(),
      }));
    },
  });

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Journal</h1>
        <form action="/api/auth/logout" method="POST">
          <button className="text-sm text-zinc-500 hover:text-zinc-900">Sign out</button>
        </form>
      </header>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <JournalList />
      </HydrationBoundary>
    </main>
  );
}
