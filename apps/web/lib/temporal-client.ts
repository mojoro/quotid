import "server-only";
import { Connection, Client } from "@temporalio/client";

declare global {
  // eslint-disable-next-line no-var
  var __temporalClient: Client | undefined;
}

export async function getTemporalClient(): Promise<Client> {
  if (global.__temporalClient) return global.__temporalClient;

  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });

  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  });

  if (process.env.NODE_ENV !== "production") global.__temporalClient = client;
  return client;
}

export const TASK_QUEUE = "quotid-main";
