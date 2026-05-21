import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Simple password gate via cookie. The dashboard renders a /login page that
// posts to /api/auth/login; on success we set an HttpOnly cookie. This
// middleware checks for that cookie on every request except the open paths.

const PASSWORD = process.env.DASHBOARD_PASSWORD || "gushwork_password_10";
const COOKIE_NAME = "icep_auth";

function isOpenPath(p: string): boolean {
  return (
    p.startsWith("/api/webhooks/") || // EmailBison / JustCall
    p.startsWith("/api/cron/") ||      // GitHub Actions
    p === "/api/auth/login" ||
    p === "/login" ||
    p.startsWith("/_next/") ||
    p === "/favicon.ico" ||
    p === "/favicon.svg" ||
    p === "/gushwork-logo.svg" ||
    p === "/gushwork-icon.svg" ||
    p === "/chime.wav"
  );
}

export function middleware(req: NextRequest) {
  if (isOpenPath(req.nextUrl.pathname)) return NextResponse.next();
  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  if (cookie === PASSWORD) return NextResponse.next();

  // API routes: 401
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  // Pages: bounce to /login with ?next=
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
