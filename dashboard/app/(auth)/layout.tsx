// Route group layout for unauthenticated pages (no sidebar).
// Next.js App Router: (auth) folder name is ignored in the URL,
// so /login still resolves to app/(auth)/login/page.tsx.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
