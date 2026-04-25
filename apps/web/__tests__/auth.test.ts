import { describe, it, expect } from "vitest";
import { hashPasscode, verifyPasscode } from "../lib/auth";

describe("argon2id passcode hashing", () => {
  it("verifies a correct passcode against its hash", async () => {
    const hash = await hashPasscode("hunter2");
    expect(await verifyPasscode("hunter2", hash)).toBe(true);
  });

  it("rejects an incorrect passcode", async () => {
    const hash = await hashPasscode("hunter2");
    expect(await verifyPasscode("wrong", hash)).toBe(false);
  });

  it("produces distinct hashes for the same passcode (random salt)", async () => {
    const a = await hashPasscode("hunter2");
    const b = await hashPasscode("hunter2");
    expect(a).not.toEqual(b);
  });
});
