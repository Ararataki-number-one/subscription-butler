import { cookies, headers } from "next/headers";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth";

/** Every legacy Server Action checks the owner session itself. Route/layout
 * guards cannot protect a globally addressable Next Server Action ID. */
export async function hasAdminSession(): Promise<boolean> {
  try {
    // A member bearer never falls back to an ambient owner cookie.
    if ((await headers()).get("authorization") !== null) return false;
    return await verifySessionToken((await cookies()).get(AUTH_COOKIE_NAME)?.value);
  } catch { return false; }
}
