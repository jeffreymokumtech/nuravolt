'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div className="h-screen w-full flex flex-col justify-center items-center text-center gap-6 p-6">
          <h2 className="text-2xl font-bold">Something went wrong!</h2>
          <p className="text-ink-2">{error.message}</p>
          <button
            onClick={() => reset()}
            className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
