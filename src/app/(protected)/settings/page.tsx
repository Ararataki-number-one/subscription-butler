import { WorkspacePageHeading } from "@/components/layout/workspace-header";
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
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
      <WorkspacePageHeading title="设置" />
      <nav aria-label="设置分类" className="sticky top-14 z-20 flex flex-wrap gap-1 border-b bg-background py-2 text-sm text-primary [&_a]:rounded-md [&_a]:px-3 [&_a]:py-2 [&_a:hover]:bg-accent [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-ring"><a href="#reminder-thresholds">提醒天数</a><a href="#space-email-settings">空间邮件</a><a href="#child-email-settings">子账号邮件</a><a href="#security-settings">登录安全</a></nav>
      <section id="expiry-settings" className="grid scroll-mt-20 items-start gap-4 lg:grid-cols-2">
      <StatusThresholdForm
        thresholds={thresholds}
        emailReminder={emailReminder}
      />
      <ChildAccountReminderForm
        settings={childAccountEmailReminder}
      />
      </section>
      <section id="security-settings" className="scroll-mt-32"><MfaSettings status={mfaStatus} /></section>
    </div>
  );
}
