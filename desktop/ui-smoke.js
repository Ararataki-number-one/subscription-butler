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
  let closing = false, navigationRetries = 0;
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
  async function waitFor(predicate, label, timeoutMs = 20000, args = []) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (errors.length) throw new Error(`UI console error during ${label}: ${errors[0]}`);
      if (await evaluate(predicate, ...args)) return;
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
  async function setInput(selector, value) {
    await evaluate((target, next) => {
      const input = document.querySelector(target);
      if (!(input instanceof HTMLInputElement)) throw new Error(`UI input unavailable: ${target}`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, next);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, selector, value);
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  const customerName = `UI Synthetic customer ${suffix}`, subscriptionName = `UI Synthetic subscription ${suffix}`;
  const sidebarCustomerName = `UI Sidebar customer ${suffix}`;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dateOffset = days => new Date(Date.parse(today + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
  try {
    assert.ok(fs.existsSync(path.join(userData, "config.json")), "Native startup did not create private config");
    steps.push("first-run-private-config-auto-initialized");
    if (!existingWindow) await window.loadURL(new URL("/", url).href);
    assert.equal(new URL(window.webContents.getURL()).pathname, "/", "Native startup did not enter the classic calendar");
    await waitFor(() => !!document.querySelector("[data-renewal-calendar]") && document.querySelector("h1")?.textContent === "续费日历", "native classic calendar");
    assert.equal(await evaluate(() => !!document.querySelector('nav[aria-label="运营功能"]')), false, "Classic calendar exposed operations tabs");
    const sidebarLinks = await evaluate(() => [...document.querySelectorAll('[data-sidebar="menu"] a[href]')].map(link => link.getAttribute("href")));
    assert.ok(sidebarLinks.includes("/spaces"), "Classic subscription sidebar link missing");
    assert.equal(sidebarLinks.indexOf("/customers"), sidebarLinks.indexOf("/spaces") + 1, "Customer sidebar link does not follow subscriptions");
    assert.equal(sidebarLinks.includes("/workspace"), false, "Classic sidebar exposed the compatibility workspace");
    steps.push("classic-calendar-startup-and-sidebar");
    await window.loadURL(new URL("/customers", url).href);
    await waitFor(() => document.querySelector("h1")?.textContent === "客户档案" && [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "新增客户" && !button.disabled), "embedded customer page is authenticated");
    assert.equal(await evaluate(() => !!document.querySelector('nav[aria-label="运营功能"]')), false, "Embedded customer page exposed operations tabs");
    await click("新增客户");
    await fill({ name: sidebarCustomerName, contact: "Synthetic sidebar contact" });
    const sidebarCustomer = (await snapshot()).customers.find(row => row.data.name === sidebarCustomerName);
    assert.ok(sidebarCustomer, "Embedded customer form did not create record");
    assert.equal(sidebarCustomer.data.contact, "Synthetic sidebar contact");
    steps.push("embedded-customer-page");
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
    const calendarFixtures = [
      { id: "subscription:" + crypto.randomUUID(), commandId: crypto.randomUUID(), name: `UI Near renewal ${suffix}`, account: "near@example.test", startDate: today, endDate: dateOffset(1) },
      { id: "subscription:" + crypto.randomUUID(), commandId: crypto.randomUUID(), name: `UI Late renewal ${suffix}`, account: "late@example.test", startDate: dateOffset(-2), endDate: dateOffset(-1) },
    ];
    await evaluate(async fixtures => {
      for (const fixture of fixtures) {
        const response = await fetch("/api/operations/commands", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: fixture.commandId, type: "subscription.save", payload: { id: fixture.id, name: fixture.name, service: "Synthetic calendar service", account: fixture.account,
            currency: "USD", amountMinor: 100, feePercent: "0", period: { unit: "day", count: 1 }, startDate: fixture.startDate, capacity: 1, allocation: "fixed" } }) });
        const result = await response.json();
        if (!response.ok) throw new Error(`Calendar fixture failed: ${response.status}`);
        const saved = result.snapshot?.subscriptions.find(row => row.id === fixture.id);
        if (!saved || saved.data.endDate !== fixture.endDate) throw new Error("Calendar day-period fixture has an incorrect due date");
      }
    }, calendarFixtures);
    await window.loadURL(new URL("/", url).href);
    await waitFor(() => !!document.querySelector("[data-renewal-calendar]") && document.querySelector("h1")?.textContent === "续费日历", "classic calendar includes new records");
    assert.equal(await evaluate(() => !!document.querySelector('nav[aria-label="运营功能"]')), false);
    assert.equal(await evaluate(() => document.querySelector('input[aria-label="日历月份"]').value), today.slice(0, 7));
    // On a month boundary yesterday and tomorrow belong to different months.
    // Check each real due-date month instead of inventing an in-month deadline.
    for (const fixture of calendarFixtures) {
      await setInput('input[aria-label="日历月份"]', fixture.endDate.slice(0, 7));
      await waitFor((recordId, account, month) => document.querySelector('input[aria-label="日历月份"]').value === month &&
        [...document.querySelectorAll("[data-calendar-entry]")].some(entry => entry.getAttribute("data-calendar-entry") === "subscription:" + recordId && entry.textContent.includes(account)),
      "calendar shows actual account and due date", 20000, [fixture.id, fixture.account, fixture.endDate.slice(0, 7)]);
    }
    await click("本月");
    await waitFor(month => document.querySelector('input[aria-label="日历月份"]').value === month, "calendar returns to current month", 20000, [today.slice(0, 7)]);
    assert.equal(await evaluate(() => document.querySelector('table[aria-label="即将到期"]').textContent.includes("near@example.test")), true, "Upcoming list omitted tomorrow's account");
    assert.equal(await evaluate(() => document.querySelector('table[aria-label="即将到期"]').textContent.includes("late@example.test")), false, "Upcoming list included an overdue account");
    await evaluate(() => {
      const details = document.querySelector('table[aria-label="已逾期"]').closest("details");
      if (!details.open) details.querySelector("summary").click();
    });
    await waitFor(() => {
      const table = document.querySelector('table[aria-label="已逾期"]');
      return table.closest("details").open && table.getClientRects().length > 0 && table.textContent.includes("late@example.test");
    }, "expanded overdue list shows yesterday's account");
    assert.equal(await evaluate(() => document.querySelector('table[aria-label="已逾期"]').textContent.includes("near@example.test")), false, "Overdue list included a future account");
    const near = calendarFixtures[0];
    await setInput('input[aria-label="日历月份"]', near.endDate.slice(0, 7));
    await setInput('input[aria-label="搜索续费账号"]', near.account);
    await waitFor(recordId => {
      const entries = [...document.querySelectorAll("[data-calendar-entry]")];
      return entries.length === 1 && entries[0].getAttribute("data-calendar-entry") === "subscription:" + recordId && entries[0].textContent.includes("near@example.test");
    }, "calendar account search filters all other events", 20000, [near.id]);
    assert.equal(await evaluate(() => document.querySelector('table[aria-label="已逾期"]').textContent.includes("late@example.test")), false, "Risk lists ignored account search");
    const nextMonth = new Date(near.endDate.slice(0, 7) + "-01T00:00:00Z"); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    await evaluate(() => document.querySelector('button[aria-label="下一月"]').click());
    await waitFor(month => document.querySelector('input[aria-label="日历月份"]').value === month, "next-month calendar control", 20000, [nextMonth.toISOString().slice(0, 7)]);
    assert.equal(await evaluate(() => document.querySelectorAll("[data-calendar-entry]").length), 0, "Calendar kept the searched event in the wrong month");
    await setInput('input[aria-label="搜索续费账号"]', "");
    await click("本月");
    await waitFor(month => document.querySelector('input[aria-label="日历月份"]').value === month, "calendar restores current month after search", 20000, [today.slice(0, 7)]);
    steps.push("renewal-calendar-all-accounts-and-risk-list");
    closing = true; window.destroy(); await restartBackend();
    window = createHiddenWindow(); onWindow(window); closing = false; monitor(window);
    const workspaceUrl = new URL("/workspace", url).href;
    try { await window.loadURL(workspaceUrl); }
    catch (error) {
      if (!/ERR_FAILED \(-2\)/u.test(error.message) || errors.length) throw error;
      const healthy = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(2000) });
      if (healthy.status !== 200 || (await healthy.json()).status !== "ok") throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
      navigationRetries += 1;
      await window.loadURL(workspaceUrl);
    }
    await waitFor(() => [...document.querySelectorAll("nav button")].some(button => button.textContent === "今日工作台"), "workspace reload");
    data = await snapshot(); assert.ok(data.customers.some(row => row.id === customer.id)); assert.ok(data.entries.some(row => row.id === receipt.id));
    assert.ok(data.customers.some(row => row.id === sidebarCustomer.id), "Embedded customer did not survive restart");
    for (const fixture of calendarFixtures) assert.ok(data.subscriptions.some(row => row.id === fixture.id && row.data.account === fixture.account && row.data.endDate === fixture.endDate), "Calendar renewal fixture did not survive restart");
    const restartedActor = await evaluate(async () => (await (await fetch("/api/operations/access", { cache: "no-store" })).json()).actor);
    assert.equal(restartedActor.role, "admin");
    assert.equal(await evaluate(() => !!document.querySelector("input[name=key],#setup-form")), false);
    steps.push("backend-window-restart-owner-auto-entry-data-persistence");
    assert.deepEqual(errors, []);
    const result = { status: "ok", visibleWindow: false, steps, navigationRetries, consoleErrors: [] };
    fs.writeFileSync(path.join(userData, "ui-smoke-result.json"), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    fs.writeFileSync(path.join(userData, "ui-smoke-result.json"), JSON.stringify({ status: "failed", visibleWindow: false, steps, error: error.message.replaceAll(authSecret, "[redacted]"), consoleErrors: errors }, null, 2));
    throw error;
  } finally { closing = true; window.destroy(); }
}
module.exports = { runUiSmoke };
