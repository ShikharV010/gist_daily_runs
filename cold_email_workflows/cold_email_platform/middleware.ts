import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// HTTP Basic Auth for the entire dashboard. Webhooks (Sequencer/JustCall) and
// the GitHub-Actions cron route stay open so they can hit us without creds.

const PASSWORD = process.env.DASHBOARD_PASSWORD || "gushwork_password_10";
const USERNAME = process.env.DASHBOARD_USERNAME || "gushwork";

function isOpenPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/cron/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/favicon.svg" ||
    pathname === "/gushwork-logo.svg"
  );
}

export function middleware(req: NextRequest) {
  if (isOpenPath(req.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const auth = req.headers.get("authorization");
  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      try {
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        const user = decoded.slice(0, colon);
        const pass = decoded.slice(colon + 1);
        if (user === USERNAME && pass === PASSWORD) {
          return NextResponse.next();
        }
      } catch {
        // fall through to 401
      }
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="In-House Cold Email Platform"',
      "Content-Type": "text/plain",
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
