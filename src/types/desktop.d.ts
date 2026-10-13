export {};

type DesktopCredentialsBridge = {
  isAvailable(): Promise<boolean>;
  loadLoginKey(): Promise<string | null>;
  saveLoginKey(loginKey: string): Promise<void>;
  clearLoginKey(): Promise<void>;
};

declare global {
  interface Window {
    teamAccountManagerDesktop?: {
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
