import {expect,it} from "vitest";
import {authenticatedCacheSession,cachedActorInSession} from "./cache-session";

it("never opens a private snapshot in a cold tab without an authenticated session marker",async()=>{
  await expect(cachedActorInSession(null,"")).resolves.toBeNull();
  await expect(cachedActorInSession(null,"member-token")).resolves.toBeNull();
  await expect(cachedActorInSession('{"actorId":"old-owner"}',"")).resolves.toBeNull();
});
it("keeps normal owner offline access within the authenticated browser session",async()=>{
  const marker=await authenticatedCacheSession("local-admin","");
  await expect(cachedActorInSession(marker,"")).resolves.toBe("local-admin");
  await expect(cachedActorInSession(marker,"member-token")).resolves.toBeNull();
});
it("binds a member snapshot to the exact member token in the current session",async()=>{
  const marker=await authenticatedCacheSession("member-a","synthetic-member-a");
  expect(marker).not.toContain("synthetic-member-a");
  await expect(cachedActorInSession(marker,"synthetic-member-a")).resolves.toBe("member-a");
  await expect(cachedActorInSession(marker,"")).resolves.toBeNull();
  await expect(cachedActorInSession(marker,"synthetic-member-b")).resolves.toBeNull();
});
it("rejects corrupt authentication markers",async()=>{
  for(const marker of ["broken","null",'{"actorId":1,"mode":"owner"}','{"actorId":"a","mode":"member"}'])
    await expect(cachedActorInSession(marker,"synthetic-token")).resolves.toBeNull();
});
