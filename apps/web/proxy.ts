import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE, findValidSession } from "@/lib/auth";

const PUBLIC_PATHS = new Set<string>(["/login"]);
const PUBLIC_PREFIXES = ["/api/auth/", "/api/webhooks/", "/_next", "/favicon", "/icon", "/apple-icon"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return loginRedirect(req);

  const session = await findValidSession(token);
  if (!session) return loginRedirect(req);

  // Sliding expiry: extend on use if >half TTL has elapsed.
  // Skipped for MVP simplicity; revisit if sessions feel sticky.

  const headers = new Headers(req.headers);
  headers.set("x-user-id", session.userId);
  return NextResponse.next({ request: { headers } });
}

function loginRedirect(req: NextRequest) {
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const url = new URL("/login", `${proto}://${host}`);
  if (req.nextUrl.pathname !== "/") {
    url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  }
  return NextResponse.redirect(url, 303);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
