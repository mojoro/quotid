import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";

const prisma = new PrismaClient();

async function main() {
  const passcodeHash = await hash(process.env.SEED_PASSCODE ?? "letmein", {
    algorithm: 2, // argon2id
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await prisma.user.upsert({
    where: { email: "john@example.com" },
    update: { passcodeHash },
    create: {
      email: "john@example.com",
      phoneNumber: process.env.SEED_PHONE_NUMBER ?? "+15555550100",
      timezone: "America/Chicago",
      passcodeHash,
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
