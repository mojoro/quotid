import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  verifyPasscode,
  newSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/auth";

// In-memory rate limiter: 5 attempts per IP per 15 minutes.
// Sufficient for single-user MVP; primary brute-force defense is argon2 cost.
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return NextResponse.json(
      { type: "about:blank", title: "Too many attempts", status: 429 },
      { status: 429, headers: { "Retry-After": "900", "Content-Type": "application/problem+json" } }
    );
  }

  const ct = req.headers.get("content-type") ?? "";
  let passcode: string | undefined;
  let next: string | undefined;

  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await req.formData();
    passcode = form.get("passcode")?.toString();
    next = form.get("next")?.toString();
  } else {
    const body = await req.json().catch(() => ({}));
    passcode = body.passcode;
    next = body.next;
  }

  if (!passcode) {
    return redirectWithError(req, "missing", next);
  }

  const user = await prisma.user.findFirst({ select: { id: true, passcodeHash: true } });
  if (!user) {
    return redirectWithError(req, "no-user", next);
  }

  const ok = await verifyPasscode(passcode, user.passcodeHash);
  if (!ok) {
    return redirectWithError(req, "invalid", next);
  }

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await prisma.session.create({ data: { token, userId: user.id, expiresAt } });

  const target = next?.startsWith("/") ? next : "/journal-entries";
  const res = NextResponse.redirect(new URL(target, publicBase(req)), 303);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}

function redirectWithError(req: NextRequest, code: string, next?: string) {
  const url = new URL("/login", publicBase(req));
  url.searchParams.set("error", code);
  if (next) url.searchParams.set("next", next);
  return NextResponse.redirect(url, 303);
}

function publicBase(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return `${proto}://${host}`;
}
