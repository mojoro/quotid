import { redirect } from "next/navigation";
import { Sidebar } from "@/components/shell/sidebar.client";
import { currentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const userId = await currentUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) redirect("/login");

  const initials = user.email
    .split("@")[0]
    .split(/[._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("") || "?";

  return (
    <div className="grid min-h-full grid-cols-1 bg-paper md:grid-cols-[220px_1fr]">
      <Sidebar email={user.email} initials={initials} />
      <main className="mx-auto w-full min-w-0 max-w-[880px] px-[clamp(18px,5vw,72px)] py-[clamp(24px,4vw,56px)]">
        {children}
      </main>
    </div>
  );
}
