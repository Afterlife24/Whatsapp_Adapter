import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Never intercept: login page, Next.js internals, static files, or the
  // proxy path itself (those go straight to the adapter via rewrite).
  if (
    pathname === "/login" ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // Check for session cookie set by the adapter (forwarded via proxy rewrite).
  const session = request.cookies.get("adapter_session");

  if (!session) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on every page route; Next.js static/_next paths are excluded above.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
