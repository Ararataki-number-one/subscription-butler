// Modified for Subscription Butler: public PWA shell and separately scoped API access.
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Public client shell contains no account data. Each operations/sync route
  // checks its cookie or scoped bearer credential before reading the ledger.
  if ((pathname === "/workspace" && request.method === "GET" && !request.headers.has("next-action")) || pathname.startsWith("/api/operations/") || pathname.startsWith("/api/sync/")) {
    return NextResponse.next();
  }

  let authenticated = false;
  try {
    authenticated = await verifySessionToken(
      request.cookies.get(AUTH_COOKIE_NAME)?.value,
    );
  } catch {
    authenticated = false;
  }
  if (pathname === "/workspace" && request.headers.has("next-action") && !authenticated) {
    return NextResponse.json({error:"请先使用本机访问密钥登录。"},{status:401});
  }

  if (pathname === "/login") {
    if (!authenticated) return NextResponse.next();

    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/workspace";
    homeUrl.search = "";
    return NextResponse.redirect(homeUrl);
  }

  if (authenticated) return NextResponse.next();

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!api/health|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
