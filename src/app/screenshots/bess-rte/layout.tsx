// Bare layout - no app chrome, no auth wrapper. This route exists to be
// screenshotted into marketing material.

export default function ScreenshotLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-gray-100">{children}</div>;
}
