import { db } from "@/db";
import {
  getChildAccountEmailReminderSettings,
  getSpaceEmailReminderSettings,
  getStatusThresholds,
} from "@/db/settings";
import { getMfaStatus } from "@/db/mfa";
import { ChildAccountReminderForm } from "@/components/settings/child-account-reminder-form";
import { MfaSettings } from "@/components/settings/mfa-settings";
import { StatusThresholdForm } from "@/components/settings/status-threshold-form";

// better-sqlite3 is a native module - keep this RSC on the Node runtime.
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const thresholds = getStatusThresholds(db);
  const emailReminder = getSpaceEmailReminderSettings(db);
  const childAccountEmailReminder = getChildAccountEmailReminderSettings(db);
  const mfaStatus = getMfaStatus(db);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">设置</h1>

      </div>

      <nav aria-label="设置分类" className="flex gap-4 border-b pb-3 text-sm text-primary"><a className="underline-offset-4 hover:underline" href="#expiry-settings">到期与邮件提醒</a><a className="underline-offset-4 hover:underline" href="#security-settings">登录安全</a></nav>
      <section id="expiry-settings" className="grid scroll-mt-20 items-start gap-4 lg:grid-cols-2">
      <StatusThresholdForm
        thresholds={thresholds}
        emailReminder={emailReminder}
      />
      <ChildAccountReminderForm
        settings={childAccountEmailReminder}
      />
      </section>
      <section id="security-settings" className="scroll-mt-20"><MfaSettings status={mfaStatus} /></section>
    </div>
  );
}
