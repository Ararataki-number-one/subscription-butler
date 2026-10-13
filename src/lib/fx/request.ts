/** One retry for transient network failures; responses are validated by the caller. */
export async function requestFx(url: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(15000), cache: "no-store" });
  } catch {
    return fetch(url, { signal: AbortSignal.timeout(15000), cache: "no-store" });
  }
}
