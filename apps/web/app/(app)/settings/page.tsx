import { prisma } from "@/lib/db";
import { currentUserId } from "@/lib/auth";
import { ScheduleForm, VoicePickerStub } from "./settings-form.client";

export default async function SettingsPage() {
  const userId = await currentUserId();

  const [user, schedule] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, phoneNumber: true, timezone: true },
    }),
    prisma.callSchedule.findUnique({
      where: { userId },
      select: { enabled: true, localTimeOfDay: true },
    }),
  ]);

  if (!user) return null;

  const initialEnabled = schedule?.enabled ?? false;
  const initialTime = schedule?.localTimeOfDay ?? "21:00";

  return (
    <div style={{ animation: "var(--animate-route-in)" }}>
      <div className="text-[11px] font-medium tracking-[0.16em] text-ink-3 uppercase">
        Settings
      </div>
      <h1 className="mt-2 font-display text-[clamp(32px,4.4vw,56px)] leading-[1.05] font-normal tracking-[-0.025em]">
        How and when to call.
      </h1>

      <section className="mt-12">
        <h2 className="font-display text-[28px] tracking-[-0.01em]">Nightly call</h2>
        <ScheduleForm
          initialEnabled={initialEnabled}
          initialTime={initialTime}
          timezone={user.timezone}
        />
      </section>

      <section className="mt-14">
        <h2 className="font-display text-[28px] tracking-[-0.01em]">Account</h2>

        <Row
          label="Phone number"
          hint="The number Quotid will call. Verified."
          flag="Edit endpoint not implemented — display only."
        >
          <ReadonlyField value={user.phoneNumber} />
        </Row>

        <Row
          label="Email"
          hint="For login and recovery."
          flag="Edit endpoint not implemented — display only."
        >
          <ReadonlyField value={user.email} />
        </Row>

        <Row
          label="Voice"
          hint="Pick the agent voice you'll hear."
        >
          <VoicePickerStub />
        </Row>

        <Row
          label="Danger zone"
          hint="Delete your account and every recording. This can't be undone."
          flag="Delete endpoint not implemented."
        >
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-2 rounded-full border border-bad/30 bg-transparent px-4 py-2.5 text-sm font-medium text-bad opacity-50"
          >
            Delete account
          </button>
        </Row>
      </section>

      <div className="h-20" />
    </div>
  );
}

function Row({
  label,
  hint,
  flag,
  children,
}: {
  label: string;
  hint?: string;
  flag?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-2.5 border-b border-paper-3 py-4.5 last-of-type:border-b-0 md:grid-cols-[220px_1fr] md:gap-8 md:py-5.5">
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        {hint && (
          <div className="mt-1 text-[13px] leading-[1.5] text-ink-3">{hint}</div>
        )}
        {flag && (
          <div className="mt-1.5 text-[12px] leading-[1.4] text-ink-4 italic">
            {flag}
          </div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ReadonlyField({ value }: { value: string }) {
  return (
    <input
      readOnly
      value={value}
      className="w-full cursor-not-allowed rounded-[10px] border border-paper-4 bg-paper-2 px-3.5 py-2.5 text-sm text-ink-2"
    />
  );
}
