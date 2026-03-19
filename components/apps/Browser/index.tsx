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
import {
  Arrow,
  Refresh,
  Stop,
} from "components/apps/Browser/NavigationIcons";
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
  const browserBoxListenersCleanupRef =
    useRef<(() => void) | undefined>(undefined);
  const browserBoxSessionRef = useRef<BrowserBoxSession | undefined>(undefined);
  const browserBoxSessionPromiseRef =
    useRef<Promise<BrowserBoxSession | undefined> | undefined>(undefined);
  const browserBoxDisconnectNotifiedRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [srcDoc, setSrcDoc] = useState("");
  const [surfaceMode, setSurfaceMode] =
    useState<BrowserSurfaceMode>("local");
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

  const showBrowserBoxStatus = useCallback(
    (message: string): void => {
      setSurfaceMode("local");
      setLoading(false);
      setSrcDoc(
        createBrowserBoxStatusPage("BrowserBox unavailable", message)
      );
      prependFileToTitle("BrowserBox unavailable");
      setIcon(id, processDirectory.Browser.icon);
      resetRemoteNavigationState();
    },
    [id, prependFileToTitle, resetRemoteNavigationState, setIcon]
  );

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
      const activeTab = tabs.find((tab) => tab.active) || tabs[0];

      if (!activeTab) {
        resetRemoteNavigationState();
        return;
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
      const handleDidStartLoading = (): void => {
        setLoading(true);
      };
      const handleDidStopLoading = (): void => {
        setLoading(false);
        runAsync(
          refreshBrowserBoxState,
          "Failed to refresh BrowserBox tab state."
        );
      };
      const handleDidNavigate = (event: Event): void => {
        const { url: navigatedUrl } =
          (event as CustomEvent<{ url?: string }>).detail || {};

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
        webview.removeEventListener(
          "did-start-loading",
          handleDidStartLoading
        );
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

  const ensureBrowserBoxElement = useCallback(
    async (): Promise<BrowserBoxWebviewElement> => {
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
        webview.setAttribute("request-timeout-ms", BROWSERBOX_REQUEST_TIMEOUT_MS);
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
    },
    [id, linkElement, wireBrowserBoxEvents]
  );

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

  const ensureRemoteBrowserReady = useCallback(async (): Promise<
    BrowserBoxWebviewElement
  > => {
    const session = await ensureBrowserBoxSession();

    if (!session?.loginUrl) {
      throw new Error("BrowserBox session did not return a loginUrl.");
    }

    const webview = await ensureBrowserBoxElement();

    if (webview.getAttribute("login-link") !== session.loginUrl) {
      webview.setAttribute("login-link", session.loginUrl);
    }

    setSurfaceMode("remote");

    if (!(await isBrowserBoxUsable(webview))) {
      await webview.whenReady();
    }

    return webview;
  }, [ensureBrowserBoxElement, ensureBrowserBoxSession, isBrowserBoxUsable]);

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
        if (inputRef.current) {
          inputRef.current.value = addressUrl;
        }
        await webview.navigateTo(addressUrl);

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
        showBrowserBoxStatus(
          `BrowserBox could not open ${addressInput}. Check the demo session service and try again.`
        );
      } finally {
        setLoading(false);
      }
    },
    [
      ensureRemoteBrowserReady,
      id,
      prependFileToTitle,
      refreshBrowserBoxState,
      setIcon,
      showBrowserBoxStatus,
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

        if ((await exists(directory)) && (await stat(directory)).isDirectory()) {
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
              (a, b) => Number(b.icon === "folder") - Number(a.icon === "folder")
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
              (a, b) => Number(b.icon === "folder") - Number(a.icon === "folder")
            );

          iframeRef.current?.addEventListener(
            "load",
            () => {
              try {
                contentWindow.document.body.querySelectorAll("a").forEach((a) => {
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
      runAsync(
        async () => {
          const webview = await ensureRemoteBrowserReady();
          await webview.goBack();
          await refreshBrowserBoxState();
        },
        "BrowserBox goBack failed."
      );
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
      runAsync(
        async () => {
          const webview = await ensureRemoteBrowserReady();
          await webview.goForward();
          await refreshBrowserBoxState();
        },
        "BrowserBox goForward failed."
      );
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
      runAsync(
        async () => {
          try {
            setLoading(true);
            const webview = await ensureRemoteBrowserReady();
            await webview.reload();
          } catch (error) {
            setLoading(false);
            throw error;
          }
        },
        "BrowserBox reload failed."
      );
      return;
    }

    runAsync(() => setUrl(history[position]), "Failed to navigate browser.");
  }, [ensureRemoteBrowserReady, history, position, runAsync, setUrl, surfaceMode]);

  const stopCurrent = useCallback((): void => {
    if (surfaceMode === "remote") {
      runAsync(
        async () => {
          const webview = browserBoxRef.current;

          if (!webview) return;

          try {
            await webview.stop();
          } finally {
            setLoading(false);
          }
        },
        "BrowserBox stop failed."
      );
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
      runAsync(() => setUrl(history[position]), "Failed to navigate browser.");
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
            onClick={loading && surfaceMode === "remote" ? stopCurrent : reloadCurrent}
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
               const nextUrl = inputRef.current.value;

               changeUrl(id, nextUrl);
               if (currentUrl.current === nextUrl) {
                 runAsync(() => setUrl(nextUrl), "Failed to navigate browser.");
               }
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
                goToLink(bookmarkUrl);
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
