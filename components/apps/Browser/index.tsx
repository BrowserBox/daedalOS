import { basename, join, resolve } from "path";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ADDRESS_INPUT_PROPS } from "components/apps/FileExplorer/AddressBar";
import useHistoryMenu from "components/apps/Browser/useHistoryMenu";
import useBookmarkMenu from "components/apps/Browser/useBookmarkMenu";
import {
  createDirectoryIndex,
  type DirectoryEntries,
} from "components/apps/Browser/directoryIndex";
import {
  BrowserBoxSessionClient,
  loadBrowserBoxWebviewAsset,
  normalizeBrowserBoxLoginLink,
  type BrowserBoxSession,
  type BrowserBoxWebviewElement,
} from "components/apps/Browser/browserboxSession";
import { Arrow, Refresh, Stop } from "components/apps/Browser/NavigationIcons";
import StyledBrowser from "components/apps/Browser/StyledBrowser";
import {
  DINO_GAME,
  HOME_PAGE,
  NOT_FOUND,
  bookmarks,
} from "components/apps/Browser/config";
import { type ComponentProcessProps } from "components/system/Apps/RenderComponent";
import useTitle from "components/system/Window/useTitle";
import { useFileSystem } from "contexts/fileSystem";
import { useProcesses } from "contexts/process";
import processDirectory from "contexts/process/directory";
import useHistory from "hooks/useHistory";
import Button from "styles/common/Button";
import Icon from "styles/common/Icon";
import {
  IFRAME_CONFIG,
  ONE_TIME_PASSIVE_EVENT,
  SHORTCUT_EXTENSION,
} from "utils/constants";
import {
  GOOGLE_SEARCH_QUERY,
  LOCAL_HOST,
  getExtension,
  getUrlOrSearch,
  haltEvent,
  label,
} from "utils/functions";
import {
  getInfoWithExtension,
  getModifiedTime,
  getShortcutInfo,
} from "components/system/Files/FileEntry/functions";
import { useSession } from "contexts/session";

declare module "react" {
  interface IframeHTMLAttributes<T> extends React.HTMLAttributes<T> {
    credentialless?: "credentialless";
  }
}

type BrowserSurfaceMode = "local" | "remote";

type RemoteNavigationState = {
  canGoBack: boolean;
  canGoForward: boolean;
};

const BROWSERBOX_REQUEST_TIMEOUT_MS = "45000";
const REMOTE_NAVIGATION_STATE: RemoteNavigationState = {
  canGoBack: false,
  canGoForward: false,
};

const createBrowserBoxStatusPage = (
  title: string,
  message: string
): string => `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body {
        align-items: center;
        background: #101418;
        color: #f5f7fa;
        display: flex;
        font-family: Arial, sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }
      main {
        max-width: 560px;
        text-align: center;
      }
      h1 {
        font-size: 28px;
        margin-bottom: 12px;
      }
      p {
        color: #d0d7de;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;

const CHECKOUT_URL = "/api/v1/checkout";
const LICENSE_URL = "https://dosaygo.com/commerce";

const createOverQuotaStatusPage = (): string => `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Demo Quota Reached</title>
    <style>
      body {
        align-items: center;
        background: #101418;
        color: #f5f7fa;
        display: flex;
        font-family: Arial, sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }
      main { max-width: 480px; text-align: center; }
      h1 { font-size: 24px; margin-bottom: 8px; }
      p { color: #d0d7de; line-height: 1.5; margin-bottom: 24px; }
      .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
      .btn {
        padding: 10px 20px;
        font-size: 14px;
        font-weight: 600;
        border-radius: 6px;
        text-decoration: none;
        cursor: pointer;
        border: none;
        font-family: inherit;
      }
      .btn-primary { background: #2563eb; color: #fff; }
      .btn-primary:hover { background: #1d4ed8; }
      .btn-outline { background: transparent; color: #93c5fd; border: 1px solid #93c5fd; }
      .btn-outline:hover { background: rgba(147,197,253,0.1); }
    </style>
  </head>
  <body>
    <main>
      <h1>Demo Quota Reached</h1>
      <p>To keep using BrowserBox, buy runtime minutes for API-powered sessions or host your own instance with a license.</p>
      <div class="actions">
        <button class="btn btn-primary" id="buyMinutesBtn">Buy Minutes</button>
        <a class="btn btn-outline" href="${LICENSE_URL}" target="_blank" rel="noopener">Get a License</a>
      </div>
    </main>
    <script>
      document.getElementById('buyMinutesBtn').addEventListener('click', async () => {
        const btn = document.getElementById('buyMinutesBtn');
        btn.textContent = 'Redirecting\u2026';
        btn.disabled = true;
        try {
          const res = await fetch('${CHECKOUT_URL}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product: 'minutes_300' }),
          });
          const data = await res.json();
          if (data.checkout_url) {
            window.top.location.href = data.checkout_url;
          } else {
            window.top.location.href = '/pricing/';
          }
        } catch {
          window.top.location.href = '/pricing/';
        }
      });
    </script>
  </body>
</html>`;

const isOverQuotaError = (error: unknown): boolean =>
  error instanceof Error &&
  (error as Error & { code?: string }).code === "RATE_LIMIT_EXCEEDED";

const Browser: FC<ComponentProcessProps> = ({ id }) => {
  const {
    icon: setIcon,
    linkElement,
    url: changeUrl,
    processes: { [id]: process },
    open,
  } = useProcesses();
  const { setForegroundId, updateRecentFiles } = useSession();
  const { prependFileToTitle } = useTitle(id);
  const { url = "" } = process || {};
  const initialUrl = url || HOME_PAGE;
  const { canGoBack, canGoForward, history, moveHistory, position } =
    useHistory(initialUrl, id);
  const { exists, fs, stat, readFile, readdir } = useFileSystem();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const browserBoxHostRef = useRef<HTMLDivElement | null>(null);
  const browserBoxRef = useRef<BrowserBoxWebviewElement | null>(null);
  const browserBoxListenersCleanupRef = useRef<(() => void) | undefined>(
    undefined
  );
  const browserBoxSessionRef = useRef<BrowserBoxSession | undefined>(undefined);
  const browserBoxSessionPromiseRef = useRef<
    Promise<BrowserBoxSession | undefined> | undefined
  >(undefined);
  const browserBoxDisconnectNotifiedRef = useRef(false);
  const primaryTabIdRef = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [srcDoc, setSrcDoc] = useState("");
  const [surfaceMode, setSurfaceMode] = useState<BrowserSurfaceMode>("local");
  const surfaceModeRef = useRef<BrowserSurfaceMode>("local");
  const [remoteNavigationState, setRemoteNavigationState] =
    useState<RemoteNavigationState>(REMOTE_NAVIGATION_STATE);
  const currentUrl = useRef("");
  const browserBoxClient = useMemo(() => new BrowserBoxSessionClient(), []);

  const changeHistory = useCallback(
    (step: number): void => {
      moveHistory(step);

      if (inputRef.current) inputRef.current.value = history[position + step];
    },
    [history, moveHistory, position]
  );

  const runAsync = useCallback(
    (operation: () => Promise<void>, errorMessage: string): void => {
      operation().catch((error) => {
        console.error(errorMessage, error);
      });
    },
    []
  );

  const goToLink = useCallback(
    (newUrl: string): void => {
      if (inputRef.current) {
        inputRef.current.value = newUrl;
      }

      changeUrl(id, newUrl);
    },
    [changeUrl, id]
  );

  const { backMenu, forwardMenu } = useHistoryMenu(
    history,
    position,
    moveHistory
  );
  const bookmarkMenu = useBookmarkMenu();

  const resetRemoteNavigationState = useCallback((): void => {
    setRemoteNavigationState(REMOTE_NAVIGATION_STATE);
  }, []);

  const waitForRemoteHostLayout = useCallback(async (): Promise<void> => {
    const host = browserBoxHostRef.current;

    if (!host) return;

    const hasRemoteHostLayout = (): boolean => {
      const { height, width } = host.getBoundingClientRect();

      return (
        getComputedStyle(host).display !== "none" && width > 0 && height > 0
      );
    };
    const waitForNextFrame = (): Promise<void> =>
      new Promise<void>((_resolve) => {
        window.requestAnimationFrame(() => _resolve());
      });
    const waitForLayoutAttempt = async (attempt: number): Promise<void> => {
      if (hasRemoteHostLayout() || attempt >= 10) return;
      await waitForNextFrame();
      await waitForLayoutAttempt(attempt + 1);
    };

    await waitForLayoutAttempt(0);
  }, []);

  const showBrowserBoxStatus = useCallback(
    (message: string): void => {
      setSurfaceMode("local");
      setLoading(false);
      setSrcDoc(createBrowserBoxStatusPage("BrowserBox unavailable", message));
      prependFileToTitle("BrowserBox unavailable");
      setIcon(id, processDirectory.Browser.icon);
      resetRemoteNavigationState();
    },
    [id, prependFileToTitle, resetRemoteNavigationState, setIcon]
  );

  const showOverQuotaStatus = useCallback((): void => {
    setSurfaceMode("local");
    setLoading(false);
    setSrcDoc(createOverQuotaStatusPage());
    prependFileToTitle("Demo Quota Reached");
    setIcon(id, processDirectory.Browser.icon);
    resetRemoteNavigationState();
  }, [id, prependFileToTitle, resetRemoteNavigationState, setIcon]);

  const notifyBrowserBoxDisconnect = useCallback(async (): Promise<void> => {
    if (browserBoxDisconnectNotifiedRef.current) return;

    const sessionId = browserBoxSessionRef.current?.sessionId;

    if (!sessionId) return;
    browserBoxDisconnectNotifiedRef.current = true;
    await browserBoxClient.notifyDisconnect(sessionId, { mode: "defer" });
  }, [browserBoxClient]);

  const isBrowserBoxUsable = useCallback(
    async (webview: BrowserBoxWebviewElement | null): Promise<boolean> => {
      if (!webview || typeof webview.getTabs !== "function") {
        return false;
      }

      try {
        await webview.getTabs();
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const refreshBrowserBoxState = useCallback(async (): Promise<void> => {
    const webview = browserBoxRef.current;

    if (!webview) return;

    try {
      const tabs = await webview.getTabs();
      const primaryId = primaryTabIdRef.current;
      const activeTab =
        (primaryId ? tabs.find((tab) => tab.id === primaryId) : undefined) ||
        tabs.find((tab) => tab.active) ||
        tabs[0];

      if (!activeTab) {
        resetRemoteNavigationState();
        return;
      }

      if (!primaryTabIdRef.current && activeTab.id) {
        primaryTabIdRef.current = activeTab.id;
      }

      setRemoteNavigationState({
        canGoBack: Boolean(activeTab.canGoBack),
        canGoForward: Boolean(activeTab.canGoForward),
      });

      if (activeTab.url && inputRef.current) {
        inputRef.current.value = activeTab.url;
      }

      if (activeTab.title) {
        prependFileToTitle(activeTab.title);
      } else if (activeTab.url) {
        prependFileToTitle(activeTab.url);
      }

      if (activeTab.faviconDataURI) {
        setIcon(id, activeTab.faviconDataURI);
      }
    } catch (error) {
      console.error("Failed to refresh BrowserBox tab state.", error);
    }
  }, [id, prependFileToTitle, resetRemoteNavigationState, setIcon]);

  const wireBrowserBoxEvents = useCallback(
    (webview: BrowserBoxWebviewElement): (() => void) => {
      const handleReady = (): void => {
        setLoading(false);
      };
      const handleRefreshState = (): void => {
        runAsync(
          refreshBrowserBoxState,
          "Failed to refresh BrowserBox tab state."
        );
      };
      const handleApiReady = (): void => {
        handleRefreshState();
      };
      const isOurTab = (tabId?: string): boolean =>
        !primaryTabIdRef.current || !tabId || tabId === primaryTabIdRef.current;

      const handleDidStartLoading = (event: Event): void => {
        const { tabId } =
          (event as CustomEvent<{ tabId?: string }>).detail || {};
        if (!isOurTab(tabId)) return;
        setLoading(true);
      };
      const handleDidStopLoading = (event: Event): void => {
        const { tabId } =
          (event as CustomEvent<{ tabId?: string }>).detail || {};
        if (!isOurTab(tabId)) return;
        setLoading(false);
        runAsync(
          refreshBrowserBoxState,
          "Failed to refresh BrowserBox tab state."
        );
      };
      const handleDidNavigate = (event: Event): void => {
        const { tabId, url: navigatedUrl } =
          (event as CustomEvent<{ tabId?: string; url?: string }>).detail || {};

        if (!isOurTab(tabId)) return;

        if (!primaryTabIdRef.current && tabId) {
          primaryTabIdRef.current = tabId;
        }

        if (typeof navigatedUrl === "string" && navigatedUrl.length > 0) {
          currentUrl.current = navigatedUrl;
          if (inputRef.current) {
            inputRef.current.value = navigatedUrl;
          }
          changeUrl(id, navigatedUrl);
        }

        setSurfaceMode("remote");
        runAsync(
          refreshBrowserBoxState,
          "Failed to refresh BrowserBox tab state."
        );
      };
      const handleTabMetadata = (): void => {
        handleRefreshState();
      };
      const handleFocus = (): void => {
        setForegroundId(id);
      };
      const handleDisconnected = (event: Event): void => {
        const { reason } =
          (event as CustomEvent<{ reason?: string }>).detail || {};

        if (reason === "login-link-changed") return;

        browserBoxSessionRef.current = undefined;
        browserBoxDisconnectNotifiedRef.current = false;
        primaryTabIdRef.current = undefined;
        resetRemoteNavigationState();

        if (surfaceModeRef.current === "remote") {
          showBrowserBoxStatus(
            "BrowserBox disconnected while loading the remote browser session."
          );
        }
      };

      webview.addEventListener("ready", handleReady);
      webview.addEventListener("api-ready", handleApiReady);
      webview.addEventListener("did-start-loading", handleDidStartLoading);
      webview.addEventListener("did-stop-loading", handleDidStopLoading);
      webview.addEventListener("did-navigate", handleDidNavigate);
      webview.addEventListener("active-tab-changed", handleTabMetadata);
      webview.addEventListener("tab-updated", handleTabMetadata);
      webview.addEventListener("favicon-changed", handleTabMetadata);
      webview.addEventListener("pointerdown", handleFocus);
      webview.addEventListener("focusin", handleFocus);
      webview.addEventListener("disconnected", handleDisconnected);

      return () => {
        webview.removeEventListener("ready", handleReady);
        webview.removeEventListener("api-ready", handleApiReady);
        webview.removeEventListener("did-start-loading", handleDidStartLoading);
        webview.removeEventListener("did-stop-loading", handleDidStopLoading);
        webview.removeEventListener("did-navigate", handleDidNavigate);
        webview.removeEventListener("active-tab-changed", handleTabMetadata);
        webview.removeEventListener("tab-updated", handleTabMetadata);
        webview.removeEventListener("favicon-changed", handleTabMetadata);
        webview.removeEventListener("pointerdown", handleFocus);
        webview.removeEventListener("focusin", handleFocus);
        webview.removeEventListener("disconnected", handleDisconnected);
      };
    },
    [
      changeUrl,
      id,
      refreshBrowserBoxState,
      resetRemoteNavigationState,
      runAsync,
      setForegroundId,
      showBrowserBoxStatus,
    ]
  );

  const ensureBrowserBoxElement =
    useCallback(async (): Promise<BrowserBoxWebviewElement> => {
      await loadBrowserBoxWebviewAsset();

      const host = browserBoxHostRef.current;

      if (!host) {
        throw new Error("BrowserBox host element is missing.");
      }

      let webview = browserBoxRef.current;

      if (!webview || !host.contains(webview)) {
        webview = document.createElement(
          "browserbox-webview"
        ) as BrowserBoxWebviewElement;
        webview.style.display = "block";
        webview.style.height = "100%";
        webview.style.width = "100%";
        webview.setAttribute("allow-user-toggle-ui", "false");
        webview.setAttribute("height", "100%");
        webview.setAttribute(
          "request-timeout-ms",
          BROWSERBOX_REQUEST_TIMEOUT_MS
        );
        webview.setAttribute("title", `${id} BrowserBox`);
        webview.setAttribute("ui-visible", "false");
        webview.setAttribute("width", "100%");
        browserBoxListenersCleanupRef.current?.();
        browserBoxListenersCleanupRef.current = wireBrowserBoxEvents(webview);
        host.replaceChildren(webview);
        browserBoxRef.current = webview;
      }

      webview.setAttribute("embedder-origin", window.location.origin);
      linkElement(id, "peekElement", webview);

      return webview;
    }, [id, linkElement, wireBrowserBoxEvents]);

  const ensureBrowserBoxSession = useCallback(async (): Promise<
    BrowserBoxSession | undefined
  > => {
    if (browserBoxSessionRef.current?.loginUrl) {
      return browserBoxSessionRef.current;
    }

    if (browserBoxSessionPromiseRef.current) {
      return browserBoxSessionPromiseRef.current;
    }

    browserBoxSessionPromiseRef.current = (async () => {
      const existingSession = await browserBoxClient.checkSession();
      const nextSession =
        existingSession.active && existingSession.loginUrl
          ? existingSession
          : await browserBoxClient.createSession();

      if (!nextSession?.loginUrl) {
        throw new Error("BrowserBox session response is missing loginUrl.");
      }

      const normalizedSession = {
        ...nextSession,
        loginUrl: normalizeBrowserBoxLoginLink(nextSession.loginUrl),
      };

      browserBoxDisconnectNotifiedRef.current = false;
      browserBoxSessionRef.current = normalizedSession;

      return normalizedSession;
    })().finally(() => {
      browserBoxSessionPromiseRef.current = undefined;
    });

    return browserBoxSessionPromiseRef.current;
  }, [browserBoxClient]);

  const ensureRemoteBrowserReady =
    useCallback(async (): Promise<BrowserBoxWebviewElement> => {
      const session = await ensureBrowserBoxSession();

      if (!session?.loginUrl) {
        throw new Error("BrowserBox session did not return a loginUrl.");
      }

      setSurfaceMode("remote");
      await waitForRemoteHostLayout();

      const webview = await ensureBrowserBoxElement();

      if (webview.getAttribute("login-link") !== session.loginUrl) {
        webview.setAttribute("login-link", session.loginUrl);
      }

      if (!(await isBrowserBoxUsable(webview))) {
        await webview.whenReady();
      }

      return webview;
    }, [
      ensureBrowserBoxElement,
      ensureBrowserBoxSession,
      isBrowserBoxUsable,
      waitForRemoteHostLayout,
    ]);

  const changeIframeWindowLocation = (
    newUrl: string,
    contentWindow: Window
  ): void => {
    let isSrcDoc = false;

    try {
      isSrcDoc = contentWindow.location?.pathname === "srcdoc";
    } catch {
      // Ignore failure to read iframe window path
    }

    if (isSrcDoc) {
      setSrcDoc("");
      iframeRef.current?.setAttribute("src", newUrl);
    } else {
      contentWindow.location?.replace(newUrl);
    }
  };

  const navigateWithBrowserBox = useCallback(
    async (addressInput: string, addressUrl: string): Promise<void> => {
      setLoading(true);
      setSrcDoc("");
      setIcon(id, processDirectory.Browser.icon);

      try {
        const webview = await ensureRemoteBrowserReady();
        currentUrl.current = addressUrl;
        changeUrl(id, addressUrl);
        if (inputRef.current) {
          inputRef.current.value = addressUrl;
        }

        const tabs = await webview.getTabs();

        await (tabs.length === 0 ? webview.createTab(addressUrl) : webview.navigateTo(addressUrl));

        if (addressUrl.startsWith(GOOGLE_SEARCH_QUERY)) {
          prependFileToTitle(`${addressInput} - Google Search`);
        } else {
          const bookmark = bookmarks.find(
            ({ url: bookmarkUrl }) => bookmarkUrl === addressInput
          );

          prependFileToTitle(bookmark?.name || addressUrl);
        }

        await refreshBrowserBoxState();
      } catch (error) {
        console.error("BrowserBox navigation failed.", error);
        if (isOverQuotaError(error)) {
          showOverQuotaStatus();
        } else if (surfaceModeRef.current !== "remote") {
          // If BrowserBox was already running, keep the remote surface visible
          // and let BBX handle transient network errors internally rather than
          // replacing the entire view with an "unavailable" page.
          showBrowserBoxStatus(
            `BrowserBox could not open ${addressInput}. Check the demo session service and try again.`
          );
        }
      } finally {
        setLoading(false);
      }
    },
    [
      changeUrl,
      ensureRemoteBrowserReady,
      id,
      prependFileToTitle,
      refreshBrowserBoxState,
      setIcon,
      showBrowserBoxStatus,
      showOverQuotaStatus,
    ]
  );

  const setUrl = useCallback(
    async (addressInput: string): Promise<void> => {
      const { contentWindow } = iframeRef.current || {};
      const isHtml =
        [".htm", ".html"].includes(getExtension(addressInput)) &&
        (await exists(addressInput));

      setIcon(id, processDirectory.Browser.icon);

      if (addressInput.toLowerCase().startsWith(DINO_GAME.url)) {
        if (contentWindow?.location) {
          setSurfaceMode("local");
          setLoading(true);
          changeIframeWindowLocation(
            `${window.location.origin}${DINO_GAME.path}`,
            contentWindow
          );
          prependFileToTitle(`${DINO_GAME.url}/`);
          resetRemoteNavigationState();
        }
        return;
      }

      if (isHtml && contentWindow?.location) {
        setSurfaceMode("local");
        setLoading(true);
        setSrcDoc((await readFile(addressInput)).toString());
        prependFileToTitle(basename(addressInput) || addressInput);
        resetRemoteNavigationState();
        return;
      }

      const processedUrl = await getUrlOrSearch(addressInput);

      if (LOCAL_HOST.has(processedUrl.host) || LOCAL_HOST.has(addressInput)) {
        if (!contentWindow?.location) return;

        setSurfaceMode("local");
        setLoading(true);
        resetRemoteNavigationState();

        const directory =
          decodeURI(processedUrl.pathname).replace(/\/$/, "") || "/";
        const searchParams = Object.fromEntries(
          new URLSearchParams(processedUrl.search.replace(";", "&")).entries()
        );
        const { O: order, C: column } = searchParams;
        const isAscending = !order || order === "A";

        let newSrcDoc = NOT_FOUND;
        let newTitle = "404 Not Found";

        if (
          (await exists(directory)) &&
          (await stat(directory)).isDirectory()
        ) {
          const dirStats = (
            await Promise.all<DirectoryEntries>(
              (await readdir(directory)).map(async (entry) => {
                const href = join(directory, entry);
                let description;
                let shortcutUrl;

                if (getExtension(entry) === SHORTCUT_EXTENSION) {
                  try {
                    ({ comment: description, url: shortcutUrl } =
                      getShortcutInfo(await readFile(href)));
                  } catch {
                    // Ignore failure to read shortcut
                  }
                }

                const filePath =
                  shortcutUrl && (await exists(shortcutUrl))
                    ? shortcutUrl
                    : href;
                const stats = await stat(filePath);
                const isDir = stats.isDirectory();

                return {
                  description,
                  href: isDir && shortcutUrl ? shortcutUrl : href,
                  icon: isDir ? "folder" : undefined,
                  modified: getModifiedTime(filePath, stats),
                  size: isDir || shortcutUrl ? undefined : stats.size,
                };
              })
            )
          )
            .sort(
              (a, b) =>
                Number(b.icon === "folder") - Number(a.icon === "folder")
            )
            .sort((a, b) => {
              const aIsFolder = a.icon === "folder";
              const bIsFolder = b.icon === "folder";

              if (aIsFolder === bIsFolder) {
                const aName = basename(a.href);
                const bName = basename(b.href);

                if (isAscending) return aName < bName ? -1 : 1;

                return aName > bName ? -1 : 1;
              }

              return 0;
            })
            .sort((a, b) => {
              if (!column || column === "N") return 0;

              const sortValue = (
                getValue: (entry: DirectoryEntries) => number | string
              ): number => {
                const aValue = getValue(a);
                const bValue = getValue(b);

                if (aValue === bValue) return 0;
                if (isAscending) return aValue < bValue ? -1 : 1;

                return aValue > bValue ? -1 : 1;
              };

              if (column === "S") {
                return sortValue(({ size }) => size ?? 0);
              }

              if (column === "M") {
                return sortValue(({ modified }) => modified ?? 0);
              }

              if (column === "D") {
                return sortValue(({ description }) => description ?? "");
              }

              return 0;
            })
            .sort(
              (a, b) =>
                Number(b.icon === "folder") - Number(a.icon === "folder")
            );

          iframeRef.current?.addEventListener(
            "load",
            () => {
              try {
                contentWindow.document.body
                  .querySelectorAll("a")
                  .forEach((a) => {
                    a.addEventListener("click", (event) => {
                      event.preventDefault();

                      const target = event.currentTarget as HTMLAnchorElement;
                      const isDir = target.getAttribute("type") === "folder";
                      const { origin, pathname, search } = new URL(target.href);

                      if (search) {
                        goToLink(`${origin}${encodeURI(directory)}${search}`);
                      } else if (isDir) {
                        goToLink(target.href);
                      } else if (fs && target.href) {
                        getInfoWithExtension(
                          fs,
                          decodeURI(pathname),
                          getExtension(pathname),
                          ({ pid, url: infoUrl }) => {
                            open(pid || "OpenWith", { url: infoUrl });

                            if (pid && infoUrl) {
                              updateRecentFiles(infoUrl, pid);
                            }
                          }
                        );
                      }
                    });
                  });
              } catch {
                // Ignore failure to add click event listeners
              }
            },
            ONE_TIME_PASSIVE_EVENT
          );

          newSrcDoc = createDirectoryIndex(
            directory,
            processedUrl.origin,
            searchParams,
            directory === "/"
              ? dirStats
              : [
                  {
                    href: resolve(directory, ".."),
                    icon: "back",
                  },
                  ...dirStats,
                ]
          );

          newTitle = `Index of ${directory}`;
        }

        setSrcDoc(newSrcDoc);
        prependFileToTitle(newTitle);
        return;
      }

      await navigateWithBrowserBox(addressInput, processedUrl.href);
    },
    [
      exists,
      fs,
      goToLink,
      id,
      navigateWithBrowserBox,
      open,
      prependFileToTitle,
      readFile,
      readdir,
      resetRemoteNavigationState,
      setIcon,
      stat,
      updateRecentFiles,
    ]
  );

  const navigateToUrl = useCallback(
    (newUrl: string): void => {
      if (inputRef.current) inputRef.current.value = newUrl;
      changeUrl(id, newUrl);
      currentUrl.current = newUrl;
      runAsync(() => setUrl(newUrl), "Failed to navigate browser.");
    },
    [changeUrl, id, runAsync, setUrl]
  );

  const supportsCredentialless = useMemo(
    () => "credentialless" in HTMLIFrameElement.prototype,
    []
  );
  const displayedCanGoBack =
    surfaceMode === "remote" ? remoteNavigationState.canGoBack : canGoBack;
  const displayedCanGoForward =
    surfaceMode === "remote"
      ? remoteNavigationState.canGoForward
      : canGoForward;

  const goBack = useCallback((): void => {
    if (surfaceMode === "remote") {
      runAsync(async () => {
        const webview = await ensureRemoteBrowserReady();
        await webview.goBack();
        await refreshBrowserBoxState();
      }, "BrowserBox goBack failed.");
      return;
    }

    changeHistory(-1);
  }, [
    changeHistory,
    ensureRemoteBrowserReady,
    refreshBrowserBoxState,
    runAsync,
    surfaceMode,
  ]);

  const goForward = useCallback((): void => {
    if (surfaceMode === "remote") {
      runAsync(async () => {
        const webview = await ensureRemoteBrowserReady();
        await webview.goForward();
        await refreshBrowserBoxState();
      }, "BrowserBox goForward failed.");
      return;
    }

    changeHistory(1);
  }, [
    changeHistory,
    ensureRemoteBrowserReady,
    refreshBrowserBoxState,
    runAsync,
    surfaceMode,
  ]);

  const reloadCurrent = useCallback((): void => {
    if (surfaceMode === "remote") {
      runAsync(async () => {
        try {
          setLoading(true);
          const webview = await ensureRemoteBrowserReady();
          await webview.reload();
        } catch (error) {
          setLoading(false);
          throw error;
        }
      }, "BrowserBox reload failed.");
      return;
    }

    runAsync(() => setUrl(history[position]), "Failed to navigate browser.");
  }, [
    ensureRemoteBrowserReady,
    history,
    position,
    runAsync,
    setUrl,
    surfaceMode,
  ]);

  const stopCurrent = useCallback((): void => {
    if (surfaceMode === "remote") {
      runAsync(async () => {
        const webview = browserBoxRef.current;

        if (!webview) return;

        try {
          await webview.stop();
        } finally {
          setLoading(false);
        }
      }, "BrowserBox stop failed.");
      return;
    }

    setLoading(false);
  }, [runAsync, surfaceMode]);

  useEffect(() => {
    surfaceModeRef.current = surfaceMode;
  }, [surfaceMode]);

  useEffect(() => {
    if (process && history[position] !== currentUrl.current) {
      currentUrl.current = history[position];
      // In remote mode BrowserBox is the navigation authority — only sync
      // the ref so daedalos state stays consistent, but do NOT re-navigate.
      if (surfaceModeRef.current !== "remote") {
        runAsync(
          () => setUrl(history[position]),
          "Failed to navigate browser."
        );
      }
    }
  }, [history, position, process, runAsync, setUrl]);

  useEffect(() => {
    const handlePageHide = (): void => {
      runAsync(
        notifyBrowserBoxDisconnect,
        "Failed to notify BrowserBox disconnect."
      );
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
      browserBoxListenersCleanupRef.current?.();
      browserBoxListenersCleanupRef.current = undefined;
      runAsync(
        notifyBrowserBoxDisconnect,
        "Failed to notify BrowserBox disconnect."
      );
    };
  }, [notifyBrowserBoxDisconnect, runAsync]);

  useEffect(() => {
    if (surfaceMode === "remote" && browserBoxRef.current) {
      linkElement(id, "peekElement", browserBoxRef.current);
    } else if (iframeRef.current) {
      linkElement(id, "peekElement", iframeRef.current);
    }
  }, [id, linkElement, surfaceMode]);

  return (
    <StyledBrowser $hasSrcDoc={Boolean(srcDoc)}>
      <nav>
        <div>
          <Button
            disabled={!displayedCanGoBack}
            onClick={goBack}
            {...label("Click to go back")}
            {...backMenu}
          >
            <Arrow direction="left" />
          </Button>
          <Button
            disabled={!displayedCanGoForward}
            onClick={goForward}
            {...label("Click to go forward")}
            {...forwardMenu}
          >
            <Arrow direction="right" />
          </Button>
          <Button
            onClick={
              loading && surfaceMode === "remote" ? stopCurrent : reloadCurrent
            }
            onContextMenu={haltEvent}
            {...label(
              loading && surfaceMode === "remote"
                ? "Stop loading this page"
                : "Reload this page"
            )}
          >
            {loading && surfaceMode === "remote" ? <Stop /> : <Refresh />}
          </Button>
        </div>
        <input
          ref={inputRef}
          defaultValue={initialUrl}
          onFocusCapture={() => inputRef.current?.select()}
          onKeyDown={({ key }) => {
            if (inputRef.current && key === "Enter") {
              navigateToUrl(inputRef.current.value);
              window.getSelection()?.removeAllRanges();
              inputRef.current.blur();
            }
          }}
          {...ADDRESS_INPUT_PROPS}
        />
      </nav>
      <nav>
        {bookmarks.map(({ name, icon, url: bookmarkUrl }) => (
          <Button
            key={name}
            onClick={({ ctrlKey }) => {
              if (ctrlKey) {
                open("Browser", { url: bookmarkUrl });
              } else {
                navigateToUrl(bookmarkUrl);
              }
            }}
            {...label(
              `${name}\n${bookmarkUrl
                .replace(/^http:\/\//, "")
                .replace(/\/$/, "")}`
            )}
            {...bookmarkMenu}
          >
            <Icon alt={name} imgSize={16} src={icon} singleSrc />
          </Button>
        ))}
      </nav>
      <div
        ref={browserBoxHostRef}
        className="browserbox-host"
        style={{ display: surfaceMode === "remote" ? "block" : "none" }}
      />
      <iframe
        ref={iframeRef}
        onLoad={() => {
          try {
            iframeRef.current?.contentWindow?.addEventListener("focus", () =>
              setForegroundId(id)
            );
          } catch {
            // Ignore failure to add focus event listener
          }

          if (loading) setLoading(false);
        }}
        srcDoc={srcDoc || undefined}
        style={{ display: surfaceMode === "local" ? "block" : "none" }}
        title={id}
        {...IFRAME_CONFIG}
        credentialless={supportsCredentialless ? "credentialless" : undefined}
      />
    </StyledBrowser>
  );
};

export default memo(Browser);
