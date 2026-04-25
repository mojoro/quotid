import { defineConfig } from "@prisma/config";

// prisma.config.ts holds datasource URLs and CLI config for Prisma v7+.
// The runtime PrismaClient receives the pooled DATABASE_URL via the constructor or env.
// DIRECT_URL is the Neon direct connection required by `prisma migrate` (pgBouncer blocks DDL).
export default defineConfig({
  migrations: {
    seed: "tsx --env-file=.env prisma/seed.ts",
  },
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
