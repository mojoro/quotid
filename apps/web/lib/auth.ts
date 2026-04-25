import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./db";

const ARGON2_OPTS = {
  algorithm: 2 as const, // argon2id
  memoryCost: 19456,     // 19 MiB — OWASP minimum for argon2id
  timeCost: 2,
  parallelism: 1,
};

export async function hashPasscode(passcode: string): Promise<string> {
  return hash(passcode, ARGON2_OPTS);
}

export async function verifyPasscode(passcode: string, stored: string): Promise<boolean> {
  try {
    return await verify(stored, passcode);
  } catch {
    return false;
  }
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export const SESSION_COOKIE = "quotid_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function currentUserId(): Promise<string> {
  const id = (await headers()).get("x-user-id");
  if (!id) redirect("/login");
  return id;
}

export async function findValidSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { token },
    select: { userId: true, expiresAt: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;
  return session;
}
