export {};
import type { CardDetails, CardRecord, CardSummary } from "@/lib/card-details";

type DesktopCredentialsBridge = {
  isAvailable(): Promise<boolean>;
  loadLoginKey(): Promise<string | null>;
  saveLoginKey(loginKey: string): Promise<void>;
  clearLoginKey(): Promise<void>;
};

declare global {
  interface Window {
    teamAccountManagerDesktop?: {
      cardVault: {
        summary(): Promise<CardSummary>;
        get(id: number): Promise<CardRecord | null>;
        save(id: number, details: CardDetails, revision: string | null): Promise<{ revision: string; updatedAt: string }>;
        remove(id: number, revision: string): Promise<void>;
        copy(id: number, field: keyof CardDetails): Promise<void>;
      };
      credentials: DesktopCredentialsBridge;
      maintenance: {
        createBackup(): Promise<{ cancelled: boolean; fileName?: string; createdAt?: string }>;
        restoreBackup(): Promise<{ cancelled: boolean; restoredAt?: string }>;
        listRestorePoints(): Promise<{ name: string; modifiedAt: string }[]>;
        restorePoint(name: string): Promise<{ cancelled: boolean; restoredAt?: string }>;
      };
      getPreferences(): Promise<{ closeToTray: boolean; notifications: boolean }>;
      setPreferences(preferences: { closeToTray?: boolean; notifications?: boolean }): Promise<{ closeToTray: boolean; notifications: boolean }>;
    };
  }
}
