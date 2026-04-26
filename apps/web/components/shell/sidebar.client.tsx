"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { QCordMark } from "@/components/brand/q-cord";
import {
  IconBook,
  IconPhone,
  IconSettings,
  IconLogout,
  IconSun,
  IconMoon,
  IconClose,
  IconMenu,
} from "@/components/icons";

type NavLink = { href: string; label: string; Icon: typeof IconBook };

const LINKS: NavLink[] = [
  { href: "/journal-entries", label: "Journal", Icon: IconBook },
  { href: "/calls", label: "Calls", Icon: IconPhone },
  { href: "/settings", label: "Settings", Icon: IconSettings },
];

type Props = {
  email: string;
  initials: string;
};

export function Sidebar({ email, initials }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMobileOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("quotid-theme", next ? "dark" : "light");
    } catch {}
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    router.push("/login");
  }

  const activeRoute = LINKS.find((l) => pathname.startsWith(l.href));

  const NavList = ({ onNavigate }: { onNavigate?: () => void }) => (
    <ul role="list" className="m-0 flex list-none flex-col gap-0.5 p-0">
      {LINKS.map((l) => {
        const active = pathname.startsWith(l.href);
        const Icn = l.Icon;
        return (
          <li key={l.href} className="m-0 p-0">
            <Link
              href={l.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-paper-2 text-ink"
                  : "text-ink-2 hover:bg-paper-2 hover:text-ink"
              }`}
            >
              <span aria-hidden="true">
                <Icn size={16} />
              </span>
              <span>{l.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );

  const Foot = () => (
    <div className="mt-auto flex flex-col gap-2.5 border-t border-paper-3 px-2 pt-3.5 pb-1">
      <div className="flex items-center gap-2.5 px-1">
        <div className="grid h-6 w-6 place-items-center rounded-full bg-paper-3 text-[11px] font-semibold text-ink-2">
          {initials}
        </div>
        <div className="min-w-0 flex-1 truncate text-xs text-ink-3" title={email}>
          {email}
        </div>
      </div>
      <div className="flex gap-1">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          aria-pressed={dark}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-transparent px-1.5 py-1.5 text-xs whitespace-nowrap text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink"
        >
          {dark ? <IconSun size={14} /> : <IconMoon size={14} />}
          <span>{dark ? "Light" : "Dark"}</span>
        </button>
        <button
          type="button"
          onClick={logout}
          aria-label="Sign out"
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-transparent px-1.5 py-1.5 text-xs whitespace-nowrap text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink"
        >
          <IconLogout size={14} />
          <span>Log out</span>
        </button>
      </div>
    </div>
  );

  const Brand = () => (
    <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-5">
      <span className="inline-flex shrink-0 items-center justify-center text-accent" aria-hidden="true">
        <QCordMark size={22} strokeWidth={28} />
      </span>
      <div className="font-display text-[22px] font-medium italic tracking-[-0.02em]">quotid</div>
    </div>
  );

  return (
    <>
      <aside
        aria-label="Primary navigation"
        className="sticky top-0 hidden h-screen flex-col gap-1 self-start border-r border-paper-3 bg-paper px-4.5 py-7 md:flex"
      >
        <Brand />
        <nav>
          <NavList />
        </nav>
        <Foot />
      </aside>

      <header
        aria-label="Primary navigation"
        className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-paper-3 bg-paper px-4.5 md:hidden"
      >
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="inline-flex items-center justify-center text-accent" aria-hidden="true">
            <QCordMark size={22} strokeWidth={28} />
          </span>
          <div className="font-display text-[19px] font-medium italic tracking-[-0.02em]">quotid</div>
        </div>
        <div className="flex-1 text-center text-[13px] tracking-[0.04em] text-ink-3 uppercase">
          {activeRoute?.label}
        </div>
        <button
          type="button"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          aria-controls="mobile-drawer"
          onClick={() => setMobileOpen((o) => !o)}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-paper-3 bg-paper-2 text-ink transition-colors hover:bg-paper-3 active:scale-[0.96]"
        >
          {mobileOpen ? <IconClose size={20} /> : <IconMenu size={20} />}
        </button>
      </header>

      <div
        id="mobile-drawer"
        aria-hidden={!mobileOpen}
        className={`fixed inset-0 z-40 md:hidden ${
          mobileOpen ? "visible pointer-events-auto" : "invisible pointer-events-none"
        }`}
      >
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={mobileOpen ? 0 : -1}
          onClick={() => setMobileOpen(false)}
          className={`absolute inset-0 cursor-pointer border-none bg-black/40 p-0 transition-opacity duration-200 ${
            mobileOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className={`absolute top-0 right-0 flex h-full w-[min(320px,86vw)] flex-col border-l border-paper-3 bg-paper transition-transform duration-[240ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${
            mobileOpen ? "translate-x-0" : "translate-x-full"
          }`}
          style={{ boxShadow: "-10px 0 40px oklch(0% 0 0 / 0.15)" }}
        >
          <div className="border-b border-paper-3 px-5 py-4.5">
            <Brand />
          </div>
          <nav className="flex-1 overflow-y-auto px-3 py-4">
            <NavList onNavigate={() => setMobileOpen(false)} />
          </nav>
          <div className="border-t border-paper-3 px-5 pt-4 pb-5.5">
            <Foot />
          </div>
        </div>
      </div>
    </>
  );
}
