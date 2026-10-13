import { handleSyncApi } from "@/lib/operations/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ segments: string[] }> };
async function handler(request: Request, context: Context) { return handleSyncApi(request, (await context.params).segments.join("/")); }
export const GET = handler;
export const POST = handler;
export const DELETE = handler;
