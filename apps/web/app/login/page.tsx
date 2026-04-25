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
    <main className="mx-auto mt-32 max-w-sm px-4">
      <h1 className="text-2xl font-semibold">Quotid</h1>
      <p className="mt-2 text-sm text-zinc-500">Enter your passcode to continue.</p>

      <form action="/api/auth/login" method="POST" className="mt-6 space-y-3">
        {next && <input type="hidden" name="next" value={next} />}
        <input
          name="passcode"
          type="password"
          autoFocus
          required
          autoComplete="current-password"
          className="w-full rounded border border-zinc-300 px-3 py-2"
          aria-label="Passcode"
        />
        <button
          type="submit"
          className="w-full rounded bg-black px-3 py-2 text-white hover:bg-zinc-800"
        >
          Sign in
        </button>
        {message && (
          <p role="alert" className="text-sm text-red-600">
            {message}
          </p>
        )}
      </form>
    </main>
  );
}
