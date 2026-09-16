// Pass-through: each docs page brings its own PublicLayout (the hub page
// directly, article pages via ContentArticleLayout). Wrapping here too would
// double the header + footer on /docs/[category]/[slug] articles.
export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
