/* eslint-disable @typescript-eslint/no-require-imports -- Native encrypted-vault regression tests use CommonJS. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { CardVault, normalizeDetails, installCardVaultHandlers } = require("../card-vault.js");
const card = { cardNumber: "4111 1111 1111 1111", cvc: "012", expiryMonth: "8", expiryYear: "28", cardholder: "Synthetic Cardholder", billingAddress: "Synthetic billing address", postalCode: "00000", country: "US", note: "Synthetic private note" };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "card-vault-test-")), key = crypto.randomBytes(32);
  let clipboardText = "";
  const clipboard = { writeText: text => { clipboardText = text; }, readText: () => clipboardText, clear: () => { clipboardText = ""; } };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString: bytes => { const d = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0,12)); d.setAuthTag(bytes.subarray(12,28)); return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString(); },
  };
  const vault = new CardVault({ userData: directory, safeStorage, clipboard });
  t.after(() => { vault.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, vault, clipboard, safeStorage };
}
test("private card fields persist only as ciphertext; lists expose last four digits only", t => {
  const { vault, directory, safeStorage } = fixture(t); const saved = vault.save(12, card, null);
  assert.ok(saved.revision); const bytes = fs.readFileSync(path.join(directory, "card-vault.bin"));
  for (const secret of ["4111111111111111", "Synthetic Cardholder", "Synthetic billing address"]) assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.deepEqual(vault.summary()[12], { last4: "1111", updatedAt: saved.updatedAt });
  assert.equal(JSON.stringify(vault.summary()).includes("cvc"), false);
  const restarted = new CardVault({ userData: directory, safeStorage });
  assert.equal(restarted.get(12).details.cvc, "012"); assert.equal(restarted.get(12).details.expiryMonth, "08"); assert.equal(restarted.get(12).details.expiryYear, "2028");
});
test("stale edits and deletes cannot overwrite newer card details", t => {
  const { vault } = fixture(t), saved = vault.save(1, card, null);
  assert.throws(() => vault.save(1, { ...card, cvc: "456" }, null), /其他窗口/u);
  assert.throws(() => vault.remove(1, "wrong-revision"), /变化/u);
  assert.equal(vault.get(1).details.cvc, "012"); vault.remove(1, saved.revision); assert.equal(vault.get(1), null);
});
test("unavailable encryption or damaged ciphertext cannot replace the original file", t => {
  const { vault, directory, safeStorage } = fixture(t), saved = vault.save(1, card, null), file = path.join(directory, "card-vault.bin"), before = fs.readFileSync(file);
  safeStorage.isEncryptionAvailable = () => false;
  assert.throws(() => vault.save(1, card, saved.revision), /加密暂不可用/u); assert.deepEqual(fs.readFileSync(file), before);
  safeStorage.isEncryptionAvailable = () => true; const damaged = Buffer.from(before); damaged[30] ^= 1; fs.writeFileSync(file, damaged);
  assert.throws(() => vault.save(1, card, saved.revision), /无法解密/u); assert.deepEqual(fs.readFileSync(file), damaged);
});
test("copy cleanup clears only the application's own clipboard value", t => {
  const { vault, clipboard } = fixture(t); vault.save(1, card, null); vault.copy(1, "cvc"); assert.equal(clipboard.readText(), "012");
  clipboard.writeText("User copied another value"); vault.dispose(); assert.equal(clipboard.readText(), "User copied another value");
  vault.copy(1, "cardNumber"); vault.dispose(); assert.equal(clipboard.readText(), "");
});
test("validation preserves leading zeroes and accepts partial records while rejecting malformed fields", t => {
  const { vault } = fixture(t);
  for (const value of [{ ...card, cvc: "abc" }, { ...card, expiryMonth: "13" }, { ...card, expiryYear: "2028", expiryMonth: "" }, { ...card, cardNumber: "4111x11111111111" }, { cardholder: "a", unexpected: "bad" }, {}]) assert.throws(() => normalizeDetails(value));
  assert.equal(normalizeDetails({ cardholder: "Name only" }).cardholder, "Name only");
  assert.throws(() => vault.get("../../secret"));
});
test("IPC requires the exact local channel page and authorized owner before any vault access", async () => {
  const handlers = new Map(); let trusted = true, ready = true, reads = 0;
  installCardVaultHandlers({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, assertRenderer: () => { if (!trusted) throw Error("Untrusted"); }, authorize: async token => { if (token !== "owner") throw Error("Forbidden"); }, ready: () => ready, vault: { get: () => { reads++; return null; } } });
  const get = handlers.get("card-vault:get"), event = { senderFrame: { url: "http://127.0.0.1:1234/reference-data/channels" } };
  await assert.rejects(get(event, "operator", 1), /Forbidden/); trusted = false; await assert.rejects(get(event, "owner", 1), /Untrusted/); trusted = true;
  await assert.rejects(get({ senderFrame: { url: "http://127.0.0.1:1234/login" } }, "owner", 1), /支付渠道/u);
  ready = false; await assert.rejects(get(event, "owner", 1), /本机维护/u); assert.equal(reads, 0);
  ready = true; await get(event, "owner", 1); assert.equal(reads, 1);
});
