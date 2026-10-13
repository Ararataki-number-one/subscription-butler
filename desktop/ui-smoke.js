/* eslint-disable @typescript-eslint/no-require-imports -- Hidden-window acceptance exercises only this application's synthetic test profile. */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

async function runUiSmoke({ BrowserWindow, url, authSecret, userData, preload, existingWindow, onWindow, restartBackend }) {
  const createHiddenWindow = () => new BrowserWindow({ show: false, width: 1400, height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload } });
  let window = existingWindow || createHiddenWindow(); onWindow(window);
  const errors = [], steps = [];
  let closing = false;
  function monitor(target) {
  target.webContents.on("console-message", (_event, details, legacyMessage) => {
    const level = typeof details === "object" ? details.level : details;
    const message = typeof details === "object" ? details.message : legacyMessage;
    if (level === "error" || level === 3) errors.push(String(message).slice(0, 500));
  });
  target.webContents.on("render-process-gone", (_event, details) => { if (!closing && details.reason !== "clean-exit") errors.push(`Renderer stopped: ${details.reason}`); });
  }
  monitor(window);
  async function evaluate(fn, ...args) {
    if (window.isDestroyed()) throw new Error("Hidden UI window stopped unexpectedly");
    return window.webContents.executeJavaScript(`(${fn.toString()})(...JSON.parse(${JSON.stringify(JSON.stringify(args))}))`);
  }
  async function waitFor(predicate, label, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (errors.length) throw new Error(`UI console error during ${label}: ${errors[0]}`);
      if (await evaluate(predicate)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const notice = await evaluate(() => document.querySelector(".notice.error,[role=alert]")?.textContent || "");
    throw new Error(`UI timeout: ${label}${notice ? ` (${notice.slice(0, 250)})` : ""}`);
  }
  async function click(text, scope = "document") {
    await evaluate((label, selector) => {
      const root = selector === "document" ? document : document.querySelector(selector);
      const button = [...root.querySelectorAll("button")].find(item => item.textContent.trim() === label && !item.disabled);
      if (!button) throw new Error(`UI button unavailable: ${label}`);
      button.click();
    }, text, scope);
  }
  async function fill(values) {
    await waitFor(() => !!document.querySelector("dialog[open] form"), "editor opens");
    await evaluate(fields => {
      const form = document.querySelector("dialog[open] form");
      for (const [name, value] of Object.entries(fields)) {
        const control = form.elements.namedItem(name);
        if (!control) throw new Error(`UI field unavailable: ${name}`);
        const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, String(value));
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (!form.checkValidity()) throw new Error("UI form failed native validation");
      form.requestSubmit();
    }, values);
    await waitFor(() => !document.querySelector("dialog[open]"), "editor saves and closes");
    const notice = await evaluate(() => document.querySelector(".notice.error,[role=alert]")?.textContent || "");
    assert.equal(notice, "", "UI displayed a save error");
  }
  async function snapshot() {
    return evaluate(async () => {
      const response = await fetch("/api/operations/snapshot", { cache: "no-store" });
      if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
      return (await response.json()).snapshot;
    });
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  const customerName = `UI Synthetic customer ${suffix}`, subscriptionName = `UI Synthetic subscription ${suffix}`;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  try {
    assert.ok(fs.existsSync(path.join(userData, "config.json")), "Native startup did not create private config");
    steps.push("first-run-private-config-auto-initialized");
    await window.loadURL(new URL("/workspace", url).href);
    await waitFor(() => [...document.querySelectorAll("nav button")].some(button => button.textContent === "今日工作台"), "workspace is authenticated");
    const currentActor = await evaluate(async () => (await (await fetch("/api/operations/access", { cache: "no-store" })).json()).actor);
    assert.equal(currentActor.role, "admin");
    assert.equal(await evaluate(() => !!document.querySelector("input[name=key],#setup-form")), false);
    assert.equal(await evaluate(() => document.cookie.includes("tam_session=")), false, "Native owner cookie must remain HttpOnly");
    steps.push("native-owner-no-key-no-setup");
    steps.push("workspace-render");
    await click("客户", "nav"); await click("新增客户");
    await fill({ name: customerName, contact: "Synthetic UI contact" });
    let data = await snapshot(); const customer = data.customers.find(row => row.data.name === customerName);
    assert.ok(customer, "Customer form did not create record"); assert.equal(customer.data.contact, "Synthetic UI contact");
    steps.push("customer-form");
    await click("订阅与位置", "nav"); await click("新增订阅");
    await fill({ name: subscriptionName, service: "Synthetic UI service", currency: "USD", amount: "125.00", feePercent: "2", capacity: "2", periodUnit: "month", periodCount: "1", startDate: today, allocation: "fixed" });
    data = await snapshot(); const subscription = data.subscriptions.find(row => row.data.name === subscriptionName);
    assert.ok(subscription); assert.equal(subscription.data.amountMinor, 12500); assert.equal(subscription.data.feePercent, "2");
    const slots = data.slots.filter(row => row.data.subscriptionId === subscription.id); assert.equal(slots.length, 2);
    steps.push("subscription-capacity-fee-form");
    await click("租期", "nav"); await click("加入 / 分配");
    await fill({ slotId: slots[0].id, customerId: customer.id, usage: "rented", startDate: today, currency: "USD", amount: "80.00", periodUnit: "month", periodCount: "1" });
    data = await snapshot(); let rental = data.rentals.find(row => row.data.customerId === customer.id);
    assert.ok(rental); assert.equal(rental.data.slotId, slots[0].id); assert.equal(rental.data.billing.amountMinor, 8000);
    assert.equal(data.bills.filter(row => row.data.rentalId === rental.id).length, 1);
    steps.push("customer-allocation-form");
    await click("续租"); await fill({ currency: "USD", amount: "80.00", periodUnit: "month", periodCount: "1" });
    data = await snapshot(); rental = data.rentals.find(row => row.id === rental.id);
    assert.equal(rental.data.periodVersion, 2); assert.equal(rental.data.history.filter(row => row.type === "renew").length, 1);
    assert.equal(data.bills.filter(row => row.data.rentalId === rental.id).length, 2);
    steps.push("renewal-form-no-fake-receipt");
    await click("收支对账", "nav");
    await evaluate(date => {
      const row = [...document.querySelectorAll("tbody tr")].find(item => item.textContent.includes(date) && [...item.querySelectorAll("button")].some(button => button.textContent === "收款"));
      const button = [...row.querySelectorAll("button")].find(item => item.textContent === "收款"); button.click();
    }, today);
    await fill({ currency: "USD", amount: "30.00", date: today });
    data = await snapshot(); const receipt = data.entries.find(row => row.data.customerId === customer.id && row.data.type === "receipt");
    assert.ok(receipt); assert.equal(receipt.data.amountMinor, 3000); assert.equal(receipt.data.appliedMinor, 3000);
    assert.equal(receipt.data.feePercent, "0"); assert.equal(receipt.data.feeAmountMinor, 0);
    assert.equal(data.entries.filter(row => row.data.customerId === customer.id && row.data.type === "receipt").length, 1);
    steps.push("partial-receipt-form");
    await click("客户", "nav"); await click(customerName);
    await waitFor(() => document.body.textContent.includes("记录详情与来源"), "customer detail history");
    await click("历史", "section.detail");
    await waitFor(() => document.body.textContent.includes("renew") && document.body.textContent.includes("join"), "rental lifecycle history");
    steps.push("customer-rental-history");
    closing = true; window.destroy(); await restartBackend();
    window = createHiddenWindow(); onWindow(window); closing = false; monitor(window);
    await window.loadURL(new URL("/workspace", url).href);
    await waitFor(() => [...document.querySelectorAll("nav button")].some(button => button.textContent === "今日工作台"), "workspace reload");
    data = await snapshot(); assert.ok(data.customers.some(row => row.id === customer.id)); assert.ok(data.entries.some(row => row.id === receipt.id));
    const restartedActor = await evaluate(async () => (await (await fetch("/api/operations/access", { cache: "no-store" })).json()).actor);
    assert.equal(restartedActor.role, "admin");
    assert.equal(await evaluate(() => !!document.querySelector("input[name=key],#setup-form")), false);
    steps.push("backend-window-restart-owner-auto-entry-data-persistence");
    assert.deepEqual(errors, []);
    const result = { status: "ok", visibleWindow: false, steps, consoleErrors: [] };
    fs.writeFileSync(path.join(userData, "ui-smoke-result.json"), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    fs.writeFileSync(path.join(userData, "ui-smoke-result.json"), JSON.stringify({ status: "failed", visibleWindow: false, steps, error: error.message.replaceAll(authSecret, "[redacted]"), consoleErrors: errors }, null, 2));
    throw error;
  } finally { closing = true; window.destroy(); }
}
module.exports = { runUiSmoke };
