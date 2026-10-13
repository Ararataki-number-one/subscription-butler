/* eslint-disable @typescript-eslint/no-require-imports -- Background desktop reminder state uses CommonJS. */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./backups.js");
function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
class ReminderManager {
  constructor({ userData, fetchReminders, notify, enabled = () => true }) {
    Object.assign(this, { fetchReminders, notify, enabled });
    this.file = path.join(userData, "notification-state.json"); this.busy = false;
  }
  async check() {
    if (this.busy || !this.enabled()) return { sent: 0 };
    this.busy = true;
    try {
      const data = await this.fetchReminders();
      if (!validDate(data?.today) || !Array.isArray(data.entries) || data.entries.length > 100000) throw new Error("到期提醒数据无效。");
      let state = { version: 1, days: {} };
      if (fs.existsSync(this.file)) {
        try {
          const stored = JSON.parse(fs.readFileSync(this.file, "utf8"));
          if (stored.version === 1 && stored.days && typeof stored.days === "object" && !Array.isArray(stored.days)) state = stored;
        } catch { /* A damaged reminder cache does not alter the ledger. */ }
      }
      const sent = new Set(Array.isArray(state.days[data.today]) ? state.days[data.today].filter(key => /^[a-f0-9]{64}$/u.test(key)) : []);
      const pending = new Map();
      for (const row of data.entries) {
        if (typeof row?.id !== "string" || row.id.length > 256 ||
            !["subscription", "member", "mother", "bill"].includes(row.kind) || !validDate(row.dueDate) ||
            !Number.isInteger(row.daysUntilDue) || row.daysUntilDue > 365 || row.daysUntilDue < -36500) throw new Error("到期提醒条目无效。");
        const status = row.daysUntilDue < 0 ? "overdue" : row.daysUntilDue === 0 ? "today" : "soon";
        const key = crypto.createHash("sha256").update(`${data.today}|${row.id}|${row.dueDate}|${status}`).digest("hex");
        if (!sent.has(key)) pending.set(key, row);
      }
      if (!pending.size) return { sent: 0 };
      const rows = [...pending.values()];
      const overdue = rows.filter(row => row.daysUntilDue < 0).length;
      const due = rows.filter(row => row.daysUntilDue === 0).length;
      const soon = rows.length - overdue - due;
      const parts = [overdue && `${overdue} 项已过期`, due && `${due} 项今天到期`, soon && `${soon} 项即将到期`].filter(Boolean);
      // Account names, contacts and amounts stay out of lock-screen text.
      const shown = await this.notify({ title: "订阅管家 · 到期提醒", body: `${parts.join("，")}。点击打开软件查看。` });
      if (!shown) return { sent: 0 };
      state.days[data.today] = [...sent, ...pending.keys()];
      const oldest = Date.parse(`${data.today}T00:00:00Z`) - 7 * 86400000;
      for (const day of Object.keys(state.days)) if (!validDate(day) || Date.parse(`${day}T00:00:00Z`) < oldest) delete state.days[day];
      writeJsonAtomic(this.file, state);
      return { sent: rows.length };
    } finally { this.busy = false; }
  }
}
module.exports = { ReminderManager, validDate };
