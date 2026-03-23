export const DEFAULT_BROWSERBOX_SESSION_API_BASE_URL =
  process.env.NEXT_PUBLIC_BROWSERBOX_SESSION_API_BASE_URL?.trim() ||
  "https://win9-5.com";

export const BROWSERBOX_WEBVIEW_ASSET_RELATIVE_PATH = "browserbox-webview.js";

const BROWSERBOX_SCRIPT_DATA_ATTRIBUTE = "data-browserbox-webview";
const SESSION_REQUEST_TIMEOUT_MS = 120_000;

type BrowserBoxSessionSource = {
  expiresAt?: number;
  expires_at?: number;
  id?: string;
  loginLink?: string;
  loginUrl?: string;
  login_url?: string;
  region?: string;
  remainingMs?: number;
  remaining_ms?: number;
  sessionId?: string;
  session_id?: string;
};

export type BrowserBoxSession = BrowserBoxSessionSource & {
  active?: boolean;
  loginUrl: string;
  region: string;
  remainingMs: number;
  sessionId: string;
};

export type BrowserBoxTab = {
  active?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  faviconDataURI?: string;
  id?: string;
  loading?: boolean;
  title?: string;
  url?: string;
};

export type BrowserBoxWebviewElement = HTMLElement & {
  getTabs: () => Promise<BrowserBoxTab[]>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  navigateTo: (url: string) => Promise<void>;
  reload: () => Promise<void>;
  stop: () => Promise<void>;
  whenReady: () => Promise<void>;
};

let browserBoxAssetPromise: Promise<void> | undefined;

const withTrailingSlashRemoved = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

export const normalizeBrowserBoxLoginLink = (rawLoginLink: string): string => {
  if (typeof rawLoginLink !== "string" || rawLoginLink.trim().length === 0) {
    return "";
  }

  try {
    const parsed = new URL(rawLoginLink, window.location.href);
    parsed.searchParams.set("ui", "false");
    return parsed.href;
  } catch {
    return rawLoginLink.trim();
  }
};

export const getBrowserBoxWebviewAssetUrl = (): string => {
  if (typeof window === "undefined") {
    return `/${BROWSERBOX_WEBVIEW_ASSET_RELATIVE_PATH}`;
  }

  return new URL(
    BROWSERBOX_WEBVIEW_ASSET_RELATIVE_PATH,
    document.baseURI
  ).toString();
};

export const loadBrowserBoxWebviewAsset = async (
  assetUrl = getBrowserBoxWebviewAssetUrl()
): Promise<void> => {
  if (typeof window === "undefined") return;
  if (window.customElements?.get("browserbox-webview")) return;
  if (!browserBoxAssetPromise) {
    browserBoxAssetPromise = new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>(
        `script[${BROWSERBOX_SCRIPT_DATA_ATTRIBUTE}="true"]`
      );

      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(), {
          once: true,
        });
        existingScript.addEventListener(
          "error",
          () =>
            reject(
              new Error("Existing BrowserBox webview asset failed to load.")
            ),
          { once: true }
        );
        return;
      }

      const script = document.createElement("script");

      script.async = true;
      script.dataset.browserboxWebview = "true";
      script.src = assetUrl;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener(
        "error",
        () =>
          reject(new Error(`Failed to load BrowserBox asset at ${assetUrl}.`)),
        { once: true }
      );
      document.head.append(script);
    }).finally(() => {
      if (!window.customElements?.get("browserbox-webview")) {
        browserBoxAssetPromise = undefined;
      }
    });
  }

  await browserBoxAssetPromise;
};

export class BrowserBoxSessionClient {
  public readonly baseUrl: string;

  public constructor(serverBaseUrl = DEFAULT_BROWSERBOX_SESSION_API_BASE_URL) {
    this.baseUrl = withTrailingSlashRemoved(serverBaseUrl.trim());
  }

  public normalizeSession(raw: BrowserBoxSessionSource): BrowserBoxSession {
    const loginUrl = raw.loginUrl || raw.login_url || raw.loginLink || "";
    const sessionId = raw.sessionId || raw.session_id || raw.id || "";
    let remainingMs = Number(raw.remainingMs ?? raw.remaining_ms);

    if (!Number.isFinite(remainingMs)) {
      const expiresAt = Number(raw.expiresAt ?? raw.expires_at);

      remainingMs = Number.isFinite(expiresAt)
        ? Math.max(0, expiresAt - Date.now())
        : 0;
    }

    return {
      ...raw,
      loginUrl,
      region: raw.region || "iad",
      remainingMs,
      sessionId,
    };
  }

  public async createSession(): Promise<BrowserBoxSession> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      SESSION_REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(`${this.baseUrl}/api/session`, {
        body: JSON.stringify({}),
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        mode: "cors",
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as
        | BrowserBoxSessionSource
        | { error?: string };

      if (!response.ok) {
        const errorMessage =
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof payload.error === "string" &&
          payload.error.length > 0
            ? payload.error
            : `Failed to create BrowserBox session (${response.status}).`;

        const error = new Error(errorMessage) as Error & { code?: string };
        if (response.status === 429) {
          error.code = "RATE_LIMIT_EXCEEDED";
        }
        throw error;
      }

      return this.normalizeSession(payload as BrowserBoxSessionSource);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  public async checkSession(): Promise<
    { active: false } | ({ active: true } & BrowserBoxSession)
  > {
    try {
      const response = await fetch(`${this.baseUrl}/api/session/status`, {
        credentials: "include",
        method: "GET",
        mode: "cors",
      });
      const payload = (await response.json().catch(() => ({}))) as
        | (BrowserBoxSessionSource & { active?: boolean })
        | { active?: boolean };

      if (!response.ok || !payload?.active) {
        return { active: false };
      }

      return {
        active: true,
        ...this.normalizeSession(payload as BrowserBoxSessionSource),
      };
    } catch {
      return { active: false };
    }
  }

  public async notifyDisconnect(
    sessionId: string,
    options: { mode?: "defer" | "hard" } = {}
  ): Promise<void> {
    if (!sessionId) return;

    const payload = JSON.stringify({
      mode: options.mode === "hard" ? "hard" : "defer",
      sessionId,
    });
    const url = `${this.baseUrl}/api/session/disconnect`;

    if (typeof navigator.sendBeacon === "function") {
      try {
        const blob = new Blob([payload], { type: "application/json" });

        navigator.sendBeacon(url, blob);
        return;
      } catch {
        // Fall through to fetch keepalive.
      }
    }

    try {
      await fetch(url, {
        body: payload,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        method: "POST",
        mode: "cors",
      });
    } catch (error) {
      console.error("BrowserBox disconnect notification failed.", error);
    }
  }
}
