import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST } from "../app/api/auth/login/route";
import { prisma } from "../lib/db";
import { hashPasscode } from "../lib/auth";

describe("POST /api/auth/login", () => {
  const PASSCODE = "test-passcode-12345";
  let userId: string;

  beforeAll(async () => {
    const hash = await hashPasscode(PASSCODE);
    const u = await prisma.user.upsert({
      where: { email: "test+login@example.com" },
      update: { passcodeHash: hash },
      create: {
        email: "test+login@example.com",
        phoneNumber: "+15555550199",
        timezone: "UTC",
        passcodeHash: hash,
      },
    });
    userId = u.id;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it("issues a session cookie on correct passcode", async () => {
    const form = new URLSearchParams({ passcode: PASSCODE });
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const res = await POST(req as never);
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/quotid_session=[^;]+;.*HttpOnly/i);
    expect(res.headers.get("location")).toMatch(/\/journal-entries$/);
  });

  it("redirects to /login?error=invalid on wrong passcode", async () => {
    const form = new URLSearchParams({ passcode: "WRONG" });
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const res = await POST(req as never);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/\/login\?error=invalid/);
  });
});
