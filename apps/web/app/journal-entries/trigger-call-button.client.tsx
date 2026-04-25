"use client";

import { useState, useTransition } from "react";
import { triggerCall, TriggerCallResult } from "./actions";

export function TriggerCallButton() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<TriggerCallResult | null>(null);

  return (
    <div className="mt-4">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await triggerCall();
            setResult(r);
          })
        }
        className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50 hover:bg-zinc-800"
      >
        {pending ? "Starting…" : "Trigger nightly call"}
      </button>
      {result?.ok && (
        <p className="mt-2 text-sm text-green-700">
          Call started — workflow <code className="font-mono">{result.workflowId}</code>
        </p>
      )}
      {result && !result.ok && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {result.error}
        </p>
      )}
    </div>
  );
}
