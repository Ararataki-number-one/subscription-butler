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
    };
  }
}
