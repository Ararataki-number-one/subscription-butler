import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type WorkerEvent = { request?: Request; data?: unknown; waitUntil(value: Promise<unknown>): void; respondWith(value: Promise<Response>): void };
function worker() {
  const listeners = new Map<string, (event: WorkerEvent) => void>(), entries = new Map<string, Response>(), pending: Promise<unknown>[] = [];
  let response: Promise<Response> | undefined, offline = false;
  const requests: { url: string; credentials: unknown }[] = [];
  const cache = { put: async (key: string, value: Response) => { expect(typeof key).toBe("string"); entries.set(new URL(key, "https://ledger.example.com").href, value.clone()); },
    match: async (key: string) => entries.get(new URL(key, "https://ledger.example.com").href)?.clone() };
  runInNewContext(readFileSync(resolve("public/operations-sw.js"), "utf8"), {
    URL, Response, self: { location: { origin: "https://ledger.example.com" }, addEventListener: (type: string, handler: (event: WorkerEvent) => void) => listeners.set(type, handler), skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() } },
    caches: { open: async () => cache, keys: async () => ["subscription-butler-public-v1"], delete: async () => true },
    fetch: async (input: string | Request, init?: RequestInit) => {
      if (offline) throw new TypeError("offline");
      const url = new URL(typeof input === "string" ? input : input.url, "https://ledger.example.com"); requests.push({ url: url.href, credentials: init?.credentials });
      return url.pathname === "/workspace" ? new Response('<html><script src="/_next/static/public.js"></script><link href="/_next/static/public.css"><a href="/api/operations/snapshot">Data</a><a href="/login">Login</a></html>', { headers: { "content-type": "text/html" } }) : new Response("public static bytes");
    },
  });
  const event = (request?: Request): WorkerEvent => ({ request, waitUntil: promise => pending.push(promise), respondWith: promise => { response = promise; } });
  return { listeners, entries, requests, event, offline: () => { offline = true; }, async settled() { while (pending.length) await Promise.all(pending.splice(0)); }, result: () => response };
}
describe("PWA cache boundary", () => {
  it("preloads only the verified public workspace shell and same-origin static assets", async () => {
    const state = worker(); state.listeners.get("install")!(state.event()); await state.settled();
    expect([...state.entries.keys()].sort()).toEqual(["https://ledger.example.com/_next/static/public.css", "https://ledger.example.com/_next/static/public.js", "https://ledger.example.com/workspace"].sort());
    expect(state.requests.every(request => request.credentials === "omit")).toBe(true);
  });
  it("does not intercept APIs, authentication, legacy pages, RSC or workspace query variants", () => {
    const state = worker();
    for (const path of ["/api/operations/snapshot", "/api/sync/changes", "/login", "/spaces", "/workspace?actor=other"]) {
      const request = new Request("https://ledger.example.com" + path); Object.defineProperty(request, "mode", { value: "navigate" });
      state.listeners.get("fetch")!(state.event(request)); expect(state.result()).toBeUndefined();
    }
    state.listeners.get("fetch")!(state.event(new Request("https://ledger.example.com/workspace", { headers: { RSC: "1" } })));
    expect(state.result()).toBeUndefined(); expect(state.entries.size).toBe(0);
  });
  it("serves a cold offline public shell without putting credentials or private responses in cache", async () => {
    const state = worker(); state.listeners.get("install")!(state.event()); await state.settled(); state.offline();
    const request = new Request("https://ledger.example.com/workspace", { headers: { cookie: "tam_session=synthetic-private-token" } }); Object.defineProperty(request, "mode", { value: "navigate" });
    state.listeners.get("fetch")!(state.event(request)); const response = await state.result()!;
    const text = await response.text(); expect(text).toContain("public.js"); expect(text).not.toContain("synthetic-private-token");
    expect([...state.entries.keys()].join(" ")).not.toContain("synthetic-private-token");
  });
});
