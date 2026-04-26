import { QCordMark } from "@/components/brand/q-cord";

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "That passcode didn't match. Try again.",
  missing: "Please enter your passcode.",
  "no-user": "No user is configured yet.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const message = error ? ERROR_MESSAGES[error] ?? "Login failed." : null;

  return (
    <main
      className="grid min-h-screen place-items-center bg-paper px-6 py-6"
      style={{
        backgroundImage:
          "radial-gradient(1000px 600px at 80% -10%, var(--color-accent-soft), transparent 60%), radial-gradient(800px 500px at -10% 110%, var(--color-cool-soft), transparent 50%)",
      }}
    >
      <div className="w-full max-w-[380px] text-center">
        <div className="mb-6 flex justify-center text-accent" aria-hidden="true">
          <QCordMark size={56} strokeWidth={26} />
        </div>
        <h1 className="m-0 font-display text-[44px] font-normal italic tracking-[-0.02em]">quotid</h1>
        <p className="mt-2 mb-9 text-sm text-ink-3">A nightly call, a daily entry.</p>

        <form action="/api/auth/login" method="POST" className="flex flex-col gap-3">
          {next && <input type="hidden" name="next" value={next} />}
          <input
            name="passcode"
            type="password"
            autoFocus
            required
            autoComplete="current-password"
            placeholder="passcode"
            aria-label="Passcode"
            className="w-full rounded-[10px] border border-paper-4 bg-paper px-3.5 py-2.5 text-center text-base tracking-[0.3em] focus:border-accent focus:shadow-[0_0_0_6px_oklch(62%_0.16_55_/_0.10)] focus:outline-none"
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-transparent bg-ink px-5.5 py-3.5 text-[15px] font-medium text-paper transition-all hover:bg-ink-2 active:scale-[0.98]"
          >
            Sign in
          </button>
          {message && (
            <p role="alert" className="text-xs text-bad">
              {message}
            </p>
          )}
        </form>

        <p className="mt-8 text-xs text-ink-3">
          Need an account? <a href="#" className="text-accent-ink">Get an invite</a>
        </p>
      </div>
    </main>
  );
}
