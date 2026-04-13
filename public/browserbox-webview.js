/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * BrowserBox SaaS desktop webview API surface.
 */

/**
 * @file BrowserBox Web Component — Canonical Embedding API
 * @description Custom element for embedding BrowserBox remote browser sessions.
 * This file is the single source of truth for the checked-in BrowserBox webview
 * API. Synced package/demo copies are refreshed with `npm run sync:webview-api`.
 * Consumers create a `<browserbox-webview>` element, set a `login-link`, and
 * call methods on it.
 *
 * ## Usage
 * ```html
 * <browserbox-webview
 *   login-link="https://bbx.example.com/login?token=..."
 *   width="100%"
 *   height="100%">
 * </browserbox-webview>
 * ```
 *
 * ## Attributes
 * | Attribute | Required | Default | Description |
 * |-----------|----------|---------|-------------|
 * | `login-link` | yes | — | Full BrowserBox login URL with auth token |
 * | `width` | no | `"100%"` | CSS width (px if bare number) |
 * | `height` | no | `"100%"` | CSS height (px if bare number) |
 * | `embedder-origin` | no | `"*"` | Origin of the embedding page (passed to BrowserBox iframe) |
 * | `request-timeout-ms` | no | `30000` | API call timeout (ms) |
 *
 * ## Events
 * | Event | Detail | Description |
 * |-------|--------|-------------|
 * | `ready` | `{ type }` | Legacy transport handshake completed |
 * | `api-ready` | `{ methods: string[] }` | Modern API available |
 * | `ready-timeout` | `{ timeoutMs, error }` | Ready handshake timed out |
 * | `tab-created` | `{ index, id, url }` | New tab opened |
 * | `tab-attached` | `{ id, url, title }` | Existing/created tab attached to a session |
 * | `tab-closed` | `{ index, id }` | Tab closed |
 * | `active-tab-changed` | `{ index, id }` | Active tab switched |
 * | `tab-updated` | `{ id, url, title, faviconDataURI }` | Tab metadata updated |
 * | `did-start-loading` | `{ tabId, url }` | Page load started |
 * | `did-stop-loading` | `{ tabId, url }` | Page load finished |
 * | `did-navigate` | `{ tabId, url }` | Navigation committed |
 * | `policy-denied` | `{ url, reason }` | Navigation blocked by policy |
 * | `sos` | `{ reasonCode, message, retryUrl, ... }` | Fatal unusable signal from embedded BrowserBox |
 * | `usability-changed` | `{ usable: boolean }` | Browser usability state changed |
 * | `disconnected` | — | Session ended (element removed or login-link changed) |
 *
 * ## Transport
 * The component auto-detects transport on first API call:
 * - **modern** (`bbx-api-call`): Full method dispatch, discovered via `api-ready`
 * - **legacy** (individual postMessage types): Fallback for older BBX versions
 * Detection is one-shot — once resolved, transport is locked for the session.
 *
 * @example
 * const bbx = document.querySelector('browserbox-webview');
 * await bbx.whenReady();
 * await bbx.createTab('https://example.com');
 * const tabs = await bbx.getTabs();
 * console.log(tabs); // [{ index: 0, id: '...', url: '...', title: '...' }]
 */

function readOnlyProperty(getter) {
  return {
    enumerable: true,
    configurable: false,
    get: getter,
  };
}

const ERROR_CODES = Object.freeze({
  BASE: 'ERR_BROWSERBOX',
  NOT_READY: 'ERR_NOT_READY',
  POLICY_DENIED: 'ERR_POLICY_DENIED',
  TIMEOUT: 'ERR_TIMEOUT',
  TRANSPORT: 'ERR_TRANSPORT',
  UNSUPPORTED: 'ERR_UNSUPPORTED',
  INVALID_ARGUMENT: 'ERR_INVALID_ARGUMENT',
  NOT_FOUND: 'ERR_NOT_FOUND',
  CONFLICT: 'ERR_CONFLICT',
  INTERNAL: 'ERR_INTERNAL',
});

const POLICY_PROFILE_ID = 'browserbox-webview-local-v1';
const POLICY_ID = 'browserbox-webview-local';
const POLICY_BASELINE_ID = 'browserbox-webview-local';
const POLICY_SCHEMA_VERSION = 1;

function createBrowserBoxError(message, {
  code = ERROR_CODES.BASE,
  retriable = false,
  status,
  cause,
  ...details
} = {}) {
  return new BrowserBoxError(message, {
    code,
    retriable,
    ...(status === undefined ? {} : { status }),
    ...(cause === undefined ? {} : { cause }),
    ...details,
  });
}

function throwInvalidArgument(message, details = {}) {
  throw createBrowserBoxError(message, {
    code: ERROR_CODES.INVALID_ARGUMENT,
    status: 400,
    ...details,
  });
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwInvalidArgument(`browserbox-webview ${label} requires an object.`, {
      label,
    });
  }
  return value;
}

function assertNonEmptyString(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throwInvalidArgument(`browserbox-webview ${label} requires a non-empty string.`, {
      label,
    });
  }
  return normalized;
}

function normalizeTabInfo(tab, fallbackIndex = null) {
  if (!tab || typeof tab !== 'object') {
    return null;
  }
  const id = [tab.id, tab.tabId, tab.targetId].find((candidate) =>
    typeof candidate === 'string' && candidate.length > 0
  ) || '';
  const faviconDataURI = typeof tab.faviconDataURI === 'string' && tab.faviconDataURI.length > 0
    ? tab.faviconDataURI
    : (typeof tab.favicon === 'string' && tab.favicon.startsWith('data:') ? tab.favicon : null);
  return {
    id,
    index: Number.isInteger(tab.index) ? tab.index : (Number.isInteger(fallbackIndex) ? fallbackIndex : 0),
    active: Boolean(tab.active ?? tab.isActive ?? tab.selected),
    url: typeof tab.url === 'string' ? tab.url : '',
    title: typeof tab.title === 'string' ? tab.title : '',
    canGoBack: Boolean(tab.canGoBack),
    canGoForward: Boolean(tab.canGoForward),
    loading: Boolean(tab.loading ?? tab.isLoading),
    hasFavicon: Boolean(tab.hasFavicon ?? faviconDataURI ?? tab.favicon),
    isDefaultFavicon: Boolean(tab.isDefaultFavicon),
    faviconDataURI,
  };
}

function coerceNumber(...candidates) {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizePageMetrics(metrics) {
  const input = metrics && typeof metrics === 'object' ? metrics : {};
  return {
    viewportWidth: coerceNumber(input.viewportWidth, input.innerWidth, input.width) ?? 0,
    viewportHeight: coerceNumber(input.viewportHeight, input.innerHeight, input.height) ?? 0,
    ...(coerceNumber(input.devicePixelRatio, globalThis.devicePixelRatio) === undefined
      ? {}
      : { devicePixelRatio: coerceNumber(input.devicePixelRatio, globalThis.devicePixelRatio) }),
    ...(coerceNumber(input.scrollX, input.scrollLeft) === undefined ? {} : { scrollX: coerceNumber(input.scrollX, input.scrollLeft) }),
    ...(coerceNumber(input.scrollY, input.scrollTop) === undefined ? {} : { scrollY: coerceNumber(input.scrollY, input.scrollTop) }),
    ...(coerceNumber(input.documentWidth, input.availWidth, input.scrollWidth) === undefined
      ? {}
      : { documentWidth: coerceNumber(input.documentWidth, input.availWidth, input.scrollWidth) }),
    ...(coerceNumber(input.documentHeight, input.availHeight, input.scrollHeight) === undefined
      ? {}
      : { documentHeight: coerceNumber(input.documentHeight, input.availHeight, input.scrollHeight) }),
  };
}

function base64EncodeBytes(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

async function normalizeCaptureResult(result, format = 'png') {
  if (typeof result === 'string') {
    if (result.startsWith('data:')) {
      return result;
    }
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mimeType};base64,${result}`;
  }
  if (result instanceof ArrayBuffer) {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mimeType};base64,${base64EncodeBytes(new Uint8Array(result))}`;
  }
  if (typeof Blob !== 'undefined' && result instanceof Blob) {
    const buffer = await result.arrayBuffer();
    return normalizeCaptureResult(buffer, format);
  }
  if (ArrayBuffer.isView(result)) {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mimeType};base64,${base64EncodeBytes(new Uint8Array(result.buffer, result.byteOffset, result.byteLength))}`;
  }
  if (result && typeof result === 'object') {
    if (typeof result.dataURI === 'string') {
      return normalizeCaptureResult(result.dataURI, format);
    }
    if (typeof result.dataUrl === 'string') {
      return normalizeCaptureResult(result.dataUrl, format);
    }
    if (typeof result.base64 === 'string') {
      return normalizeCaptureResult(result.base64, format);
    }
    if (typeof result.data === 'string') {
      return normalizeCaptureResult(result.data, format);
    }
  }
  throw createBrowserBoxError('browserbox-webview capture returned an unsupported result.', {
    code: ERROR_CODES.INTERNAL,
    status: 500,
  });
}

function extractEvaluateValue(result) {
  if (typeof result === 'string') {
    return result;
  }
  if (typeof result?.result?.value === 'string') {
    return result.result.value;
  }
  if (typeof result?.value === 'string') {
    return result.value;
  }
  return '';
}

function normalizePreviewResult(target, resolution) {
  const source = resolution && typeof resolution === 'object' ? resolution : {};
  const selector = typeof target?.selector === 'string'
    ? target.selector
    : (typeof source.selector === 'string' ? source.selector : undefined);
  const matches = Number.isInteger(source.matchCount)
    ? source.matchCount
    : (Array.isArray(source.matches) ? source.matches.length : 0);
  const sample = Array.isArray(source.sample)
    ? source.sample
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        ...(typeof entry.text === 'string' ? { text: entry.text } : {}),
        ...(typeof entry.href === 'string' ? { href: entry.href } : {}),
      }))
    : undefined;
  return {
    ...(selector ? { selector } : {}),
    matches,
    ...(sample && sample.length > 0 ? { sample } : {}),
  };
}

function normalizeExtractResult(target, result) {
  const selector = typeof target?.selector === 'string'
    ? target.selector
    : (typeof result?.selector === 'string' ? result.selector : undefined);
  const rawItems = Array.isArray(result)
    ? result
    : (Array.isArray(result?.items) ? result.items : []);
  const items = rawItems
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      ...(typeof entry.text === 'string' ? { text: entry.text } : {}),
      ...(typeof entry.href === 'string' ? { href: entry.href } : {}),
      ...(typeof entry.html === 'string' ? { html: entry.html } : {}),
    }));
  return {
    ...(selector ? { selector } : {}),
    items,
    count: Number.isInteger(result?.count) ? result.count : items.length,
  };
}

function normalizeRawSelection(rawSelection) {
  const input = rawSelection && typeof rawSelection === 'object' ? rawSelection : {};
  const selectors = Array.isArray(input.selectors)
    ? input.selectors.filter((value) => typeof value === 'string' && value.length > 0)
    : (typeof input.selector === 'string' && input.selector.length > 0 ? [input.selector] : []);
  return {
    ...(typeof input.selector === 'string' && input.selector.length > 0 ? { selector: input.selector } : {}),
    ...(selectors.length > 0 ? { selectors } : {}),
    ...(typeof input.text === 'string' ? { text: input.text } : {}),
    ...(typeof input.href === 'string' ? { href: input.href || null } : {}),
    ...(typeof input.htmlSnippet === 'string'
      ? { htmlSnippet: input.htmlSnippet }
      : (typeof input.html === 'string' ? { htmlSnippet: input.html } : {})),
  };
}

function normalizeActionResult(action, value) {
  return {
    ok: true,
    action,
    ...(value === undefined ? {} : { value }),
  };
}

function createLocalPolicySnapshot(capabilities, metadata = {}) {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    policyProfile: POLICY_PROFILE_ID,
    policyId: POLICY_ID,
    baselineId: POLICY_BASELINE_ID,
    policyVersion: 1,
    issuedAt: timestamp,
    updatedAt: timestamp,
    ...metadata,
    apiCapabilities: clonePolicyTree(capabilities),
  };
}

function createTabsNamespace(instance) {
  return Object.freeze({
    async list() {
      const tabs = await instance.callApi('getTabs');
      return Array.isArray(tabs)
        ? tabs.map((tab, index) => normalizeTabInfo(tab, index)).filter(Boolean)
        : [];
    },
    async getActive() {
      return instance._getActiveTabInfo();
    },
    async create(input = {}) {
      assertPlainObject(input, 'tabs.create(input)');
      const url = typeof input.url === 'string' ? input.url : '';
      const shouldActivate = input.active !== false;
      const previousActiveTab = shouldActivate ? null : await instance._getActiveTabInfo();
      const beforeCount = await instance.callApi('getTabCount');
      await instance.callApi('createTab', url);
      await instance.callApi('waitForTabCount', beforeCount + 1, {
        timeoutMs: instance.requestTimeoutMs,
      });
      const tabs = await this.list();
      const createdTab = tabs[tabs.length - 1] || null;
      if (!shouldActivate && previousActiveTab?.id) {
        await instance.callApi('switchToTabById', previousActiveTab.id);
      }
      return createdTab;
    },
    async activate(tabId) {
      return instance.callApi('switchToTabById', assertNonEmptyString(tabId, 'tabs.activate(tabId)'));
    },
    async close(tabId) {
      return instance.callApi('closeTabById', assertNonEmptyString(tabId, 'tabs.close(tabId)'));
    },
    async closeAll() {
      return instance.callApi('closeAllTabs', { keep: 0 });
    },
  });
}

function createPageNamespace(instance) {
  return Object.freeze({
    async navigate(url, opts = {}) {
      return instance.callApi('navigateTo', assertNonEmptyString(url, 'page.navigate(url)'), opts);
    },
    async reload() {
      return instance.callApi('reload');
    },
    async back() {
      return instance.callApi('goBack');
    },
    async forward() {
      return instance.callApi('goForward');
    },
    async stop() {
      return instance.callApi('stop');
    },
    async url() {
      return (await instance._getActiveTabInfo('page.read'))?.url || '';
    },
    async title() {
      return (await instance._getActiveTabInfo('page.read'))?.title || '';
    },
    async favicon() {
      const activeTab = await instance._getActiveTabInfo('page.read');
      return activeTab?.faviconDataURI || activeTab?.favicon || null;
    },
    async metrics() {
      return normalizePageMetrics(await instance.callApi('getScreenMetrics'));
    },
    async text(options = {}) {
      return instance._getPageText(options);
    },
  });
}

function createCaptureNamespace(instance) {
  return Object.freeze({
    async enable(enabled = true) {
      instance._assertCapability('capture.frame');
      return instance.callApi('frameCapture', Boolean(enabled));
    },
    async next() {
      instance._assertCapability('capture.frame');
      return instance.callApi('getFrame');
    },
    async frame(options = {}) {
      instance._assertCapability('capture.frame');
      return normalizeCaptureResult(
        await instance.callApi('captureFrame', { ...options, scope: 'frame' }),
        options?.format,
      );
    },
    async viewport(options = {}) {
      instance._assertCapability('capture.viewport');
      return normalizeCaptureResult(
        await instance.callApi('captureFrame', { ...options, scope: 'viewport' }),
        options?.format,
      );
    },
  });
}

function cloneJsonValue(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function generateOpaqueId(prefix = 'bbx') {
  const token = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${token}`;
}

function scheduleMicrotask(callback) {
  if (typeof globalThis.queueMicrotask === 'function') {
    globalThis.queueMicrotask(callback);
    return;
  }
  Promise.resolve().then(callback);
}

function isDomNode(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.nodeType === 'number';
}

function normalizeAugmentSpec(spec) {
  assertPlainObject(spec, 'augment(spec)');
  const kind = assertNonEmptyString(spec.kind || 'custom', 'augment(spec.kind)');
  const space = assertNonEmptyString(spec.space || 'session', 'augment(spec.space)');
  return {
    id: typeof spec.id === 'string' && spec.id.trim() ? spec.id.trim() : generateOpaqueId('bbx-augment'),
    kind,
    space,
    position: typeof spec.position === 'string' ? spec.position : undefined,
    target: spec.target && typeof spec.target === 'object' ? cloneJsonValue(spec.target) : undefined,
    content: normalizeAugmentContent(spec.content),
    style: spec.style,
    interactive: Boolean(spec.interactive),
    visible: spec.visible !== false,
  };
}

function normalizeAugmentContent(content) {
  if (content === undefined || content === null || isDomNode(content)) {
    return content;
  }
  if (typeof content === 'string') {
    return { type: 'html', html: content };
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if (typeof content.type === 'string') {
      if (content.type === 'text' && typeof content.text === 'string') {
        return { type: 'text', text: content.text };
      }
      if (content.type === 'html' && typeof content.html === 'string') {
        return { type: 'html', html: content.html };
      }
      if (content.type === 'json' && content.data !== undefined) {
        return { type: 'json', data: cloneJsonValue(content.data) };
      }
      throwInvalidArgument('browserbox-webview augment content type is invalid.', {
        contentType: content.type,
      });
    }
    if (typeof content.html === 'string') {
      return { type: 'html', html: content.html };
    }
    return { type: 'json', data: cloneJsonValue(content) };
  }
  if (Array.isArray(content)) {
    return { type: 'json', data: cloneJsonValue(content) };
  }
  throwInvalidArgument('browserbox-webview augment content must be text/html/json compatible.', {
    contentType: typeof content,
  });
}

function normalizeAugmentInfo(spec) {
  return {
    id: spec.id,
    kind: spec.kind,
    space: spec.space,
    ...(spec.position === undefined ? {} : { position: spec.position }),
    ...(spec.target === undefined ? {} : { target: cloneJsonValue(spec.target) }),
    interactive: Boolean(spec.interactive),
    visible: spec.visible !== false,
  };
}

function createAugmentApi(instance) {
  const augment = async (spec) => instance._createAugment(spec);
  augment.update = async (id, patch) => instance._updateAugment(id, patch);
  augment.remove = async (id) => instance._removeAugment(id);
  augment.list = async () => instance._listAugments();
  return Object.freeze(augment);
}

function createPatternHandle(instance, pattern, previewId) {
  return Object.freeze({
    get selector() {
      return typeof pattern?.selector === 'string' ? pattern.selector : '';
    },
    async preview() {
      return instance._previewSelectionPattern(pattern, previewId);
    },
    async extract(options = {}) {
      return instance._extractSelection(pattern, options);
    },
  });
}

function createSelectionHandle(instance, rawSelection) {
  const previewId = generateOpaqueId('bbx-select-preview');
  return Object.freeze({
    async getRaw() {
      return normalizeRawSelection(cloneJsonValue(rawSelection));
    },
    async generalize() {
      const pattern = await instance._generalizeSelection(rawSelection);
      return createPatternHandle(instance, pattern, previewId);
    },
    async preview() {
      return instance._previewSelectionPattern(rawSelection, previewId);
    },
    async extract(options = {}) {
      return instance._extractSelection(rawSelection, options);
    },
  });
}

function createSessionFacade(instance) {
  const session = {
    health: (options) => instance.health(options),
    refresh: () => instance.refresh(),
    disconnect: () => instance.disconnect(),
    observe: (config) => instance.observe(config),
    act: (action) => instance.act(action),
    capabilities: () => instance.capabilities(),
    select: (options) => instance.select(options),
    frameCapture: (enabled = true) => instance.frameCapture(enabled),
    getFrame: () => instance.getFrame(),
    cleanSlate: (url) => instance.cleanSlate(url),
  };

  Object.defineProperties(session, {
    id: readOnlyProperty(() => instance.routingMid || null),
    usable: readOnlyProperty(() => instance._usable),
    transport: readOnlyProperty(() => instance._transportMode),
    ready: readOnlyProperty(() => instance._isReady),
    tabs: readOnlyProperty(() => instance.tabs),
    page: readOnlyProperty(() => instance.page),
    capture: readOnlyProperty(() => instance.capture),
    augment: readOnlyProperty(() => instance.augment),
    policy: readOnlyProperty(() => instance.policy),
  });

  return Object.freeze(session);
}

const POLICY_DEFAULTS = {
  tabs: { read: true, write: true },
  page: { read: true, navigate: true },
  act: {
    navigate: true,
    click: true,
    type: true,
    evaluate: true,
    wait: true,
  },
  augment: {
    read: false,
    write: false,
    page: false,
    viewport: false,
    chrome: false,
    session: false,
  },
  capture: { frame: false, viewport: false, stream: false },
  select: { use: false, extract: false },
  events: { read: true },
  policy: { read: true },
};

const INTERACTION_MODE_PRESETS = {
  'view-only': {
    tabs: { write: false },
    page: { navigate: false },
    act: {
      navigate: false,
      click: false,
      type: false,
      evaluate: false,
      wait: false,
    },
  },
  limited: {
    tabs: { write: false },
    page: { navigate: true },
    act: {
      navigate: true,
      click: true,
      type: true,
      evaluate: false,
      wait: true,
    },
  },
  full: {},
};

const IMPLEMENTED_CAPABILITIES = {
  'tabs.read': true,
  'tabs.write': true,
  'page.read': true,
  'page.navigate': true,
  'act.navigate': true,
  'act.click': true,
  'act.type': true,
  'act.evaluate': true,
  'act.wait': true,
  'augment.read': true,
  'augment.write': true,
  'augment.page': true,
  'augment.viewport': true,
  'augment.chrome': true,
  'augment.session': true,
  'capture.frame': true,
  'capture.viewport': true,
  'capture.stream': false,
  'select.use': true,
  'select.extract': true,
  'events.read': true,
  'policy.read': true,
};

const METHOD_CAPABILITY_MAP = {
  getTabs: ['tabs.read'],
  getActiveTabIndex: ['tabs.read'],
  getTabCount: ['tabs.read'],
  getFavicons: ['tabs.read'],
  waitForNonDefaultFavicon: ['tabs.read'],
  waitForTabCount: ['tabs.read'],
  waitForTabUrl: ['tabs.read'],
  createTab: ['tabs.write'],
  createTabs: ['tabs.write'],
  closeTab: ['tabs.write'],
  closeTabById: ['tabs.write'],
  closeAllTabs: ['tabs.write'],
  switchToTab: ['tabs.write'],
  switchToTabById: ['tabs.write'],
  navigateTo: ['page.navigate'],
  navigateTab: ['tabs.write', 'page.navigate'],
  submitOmnibox: ['page.navigate'],
  reload: ['page.navigate'],
  goBack: ['page.navigate'],
  goForward: ['page.navigate'],
  stop: ['page.navigate'],
  getPageText: ['page.read'],
  resolvePageTarget: ['page.read'],
  beginSelect: ['select.use'],
  generalizeSelection: ['select.use'],
  extractSelection: ['select.extract'],
  captureFrame: ['capture.frame'],
  getScreenMetrics: ['page.read'],
  waitForSelector: ['act.wait'],
  waitForNavigation: ['act.wait'],
  click: ['act.click'],
  type: ['act.type'],
  evaluate: ['act.evaluate'],
  uiVisible: ['page.read'],
  allowUserToggleUI: ['page.read'],
  frameCapture: ['capture.frame'],
  getFrame: ['capture.frame'],
  cleanSlate: ['tabs.write', 'page.navigate'],
};

const EVENT_ALIAS_MAP = {
  'api-ready': ['api.ready'],
  'usability-changed': ['session.usability.changed'],
  'iframe-retry': ['session.retry'],
  disconnected: ['session.disconnected'],
  'tab-created': ['tab.created'],
  'tab-attached': ['tab.attached'],
  'tab-closed': ['tab.closed'],
  'tab-updated': ['tab.updated'],
  'active-tab-changed': ['tab.activated'],
  'did-navigate': ['page.navigated'],
  'did-start-loading': ['page.load.started'],
  'did-stop-loading': ['page.load.stopped'],
  'favicon-changed': ['page.favicon.changed'],
  'policy-denied': ['policy.denied'],
};

function debugBrowserBoxWebview(...args) {
  if (globalThis.BROWSERBOX_WEBVIEW_DEBUG === true) {
    console.log(...args);
  }
}

function clonePolicyTree(node) {
  if (node === null || typeof node !== 'object') {
    return node;
  }

  const rootClone = Array.isArray(node) ? [] : {};
  const seen = new WeakMap([[node, rootClone]]);
  const pending = [{ source: node, clone: rootClone }];

  while (pending.length > 0) {
    const { source, clone } = pending.pop();
    const entries = Array.isArray(source) ? source.entries() : Object.entries(source);

    for (const [key, value] of entries) {
      if (value === null || typeof value !== 'object') {
        clone[key] = value;
        continue;
      }

      const existingClone = seen.get(value);
      if (existingClone) {
        clone[key] = existingClone;
        continue;
      }

      const childClone = Array.isArray(value) ? [] : {};
      seen.set(value, childClone);
      clone[key] = childClone;
      pending.push({ source: value, clone: childClone });
    }
  }

  return rootClone;
}

function freezePolicyTree(node) {
  if (node === null || typeof node !== 'object') {
    return node;
  }

  const seen = new WeakSet();
  const pending = [node];

  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) {
      continue;
    }

    seen.add(current);
    Object.freeze(current);

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        pending.push(value);
      }
    }
  }

  return node;
}

function createPolicySnapshotView(snapshot) {
  return freezePolicyTree(clonePolicyTree(snapshot));
}

function mergePolicyTree(base, patch) {
  if (typeof base === 'boolean') {
    return typeof patch === 'boolean' ? patch : base;
  }
  const patchObject = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const merged = {};
  for (const [key, value] of Object.entries(base)) {
    merged[key] = mergePolicyTree(value, patchObject[key]);
  }
  return merged;
}

function flattenPolicyTree(node, prefix = '', output = {}) {
  for (const [key, value] of Object.entries(node)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'boolean') {
      output[nextPrefix] = value;
    } else {
      flattenPolicyTree(value, nextPrefix, output);
    }
  }
  return output;
}

function intersectPolicyTrees(base, restriction) {
  if (typeof base === 'boolean') {
    return base && Boolean(restriction);
  }
  const patch = restriction && typeof restriction === 'object' && !Array.isArray(restriction) ? restriction : {};
  const merged = {};
  for (const [key, value] of Object.entries(base)) {
    merged[key] = intersectPolicyTrees(value, patch[key]);
  }
  return merged;
}

function isPolicySnapshot(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractApiCapabilities(policySnapshot) {
  if (!isPolicySnapshot(policySnapshot)) {
    return clonePolicyTree(POLICY_DEFAULTS);
  }
  const source = isPolicySnapshot(policySnapshot.apiCapabilities)
    ? policySnapshot.apiCapabilities
    : policySnapshot;
  return mergePolicyTree(clonePolicyTree(POLICY_DEFAULTS), source);
}

function mergePolicySnapshots(serverPolicySnapshot, localPolicySnapshot) {
  const localCapabilities = extractApiCapabilities(localPolicySnapshot);
  const serverCapabilities = serverPolicySnapshot
    ? extractApiCapabilities(serverPolicySnapshot)
    : clonePolicyTree(POLICY_DEFAULTS);
  const effectiveCapabilities = intersectPolicyTrees(serverCapabilities, localCapabilities);
  const timestamp = new Date().toISOString();
  const base = serverPolicySnapshot && isPolicySnapshot(serverPolicySnapshot)
    ? clonePolicyTree(serverPolicySnapshot)
    : clonePolicyTree(localPolicySnapshot);
  return {
    schemaVersion: Number.isInteger(base?.schemaVersion) ? base.schemaVersion : POLICY_SCHEMA_VERSION,
    policyProfile: typeof base?.policyProfile === 'string' ? base.policyProfile : POLICY_PROFILE_ID,
    policyId: typeof base?.policyId === 'string' ? base.policyId : POLICY_ID,
    baselineId: typeof base?.baselineId === 'string' ? base.baselineId : POLICY_BASELINE_ID,
    policyVersion: Number.isInteger(base?.policyVersion) ? base.policyVersion : 1,
    issuedAt: typeof base?.issuedAt === 'string' ? base.issuedAt : timestamp,
    updatedAt: timestamp,
    ...base,
    apiCapabilities: effectiveCapabilities,
  };
}

function normalizePolicyStateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }
  const candidate = snapshot.policy && typeof snapshot.policy === 'object' && !Array.isArray(snapshot.policy)
    ? snapshot.policy
    : snapshot;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  return {
    ...clonePolicyTree(candidate),
    apiCapabilities: extractApiCapabilities(candidate),
  };
}

const EVENT_CAPABILITY_RULES = Object.freeze({
  'tab-created': 'tabs.read',
  'tab-attached': 'tabs.read',
  'tab-closed': 'tabs.read',
  'tab-updated': 'tabs.read',
  'active-tab-changed': 'tabs.read',
  'tab.created': 'tabs.read',
  'tab.attached': 'tabs.read',
  'tab.closed': 'tabs.read',
  'tab.updated': 'tabs.read',
  'tab.activated': 'tabs.read',
  'did-navigate': 'page.read',
  'did-start-loading': 'page.read',
  'did-stop-loading': 'page.read',
  'favicon-changed': 'page.read',
  'page.navigated': 'page.read',
  'page.load.started': 'page.read',
  'page.load.stopped': 'page.read',
  'page.favicon.changed': 'page.read',
  'policy.changed': 'policy.read',
});

function createPolicyNamespace(instance) {
  return Object.freeze({
    async get() {
      instance._assertCapability('policy.read');
      return instance._getPolicySnapshotView();
    },
  });
}

class BrowserBoxError extends Error {
  constructor(message, {
    code = ERROR_CODES.BASE,
    retriable,
    status,
    cause,
    ...details
  } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (retriable !== undefined) {
      this.retriable = Boolean(retriable);
    }
    if (status !== undefined) {
      this.status = status;
    }
    if (cause !== undefined) {
      this.cause = cause;
    }
    Object.assign(this, details);
  }

  toJSON() {
    const json = {
      name: this.name,
      message: this.message,
      code: this.code,
    };
    for (const key of Object.keys(this)) {
      if (!(key in json)) {
        json[key] = this[key];
      }
    }
    return json;
  }
}

class BrowserBoxPolicyError extends BrowserBoxError {
  constructor(capability) {
    super(`browserbox-webview policy denied capability '${capability}'.`, {
      code: ERROR_CODES.POLICY_DENIED,
      status: 403,
      capability,
      source: 'embedder-policy',
    });
  }
}

class BrowserBoxWebview extends HTMLElement {
  static get observedAttributes() {
    return [
      'login-link',
      'width',
      'height',
      'embedder-origin',
      'parent-origin', // deprecated alias for embedder-origin
      'request-timeout-ms',
      'ui-visible',
      'allow-user-toggle-ui',
      'policy',
      'interaction-mode',
      'chrome',
      'augment-root',
      'capture',
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._shell = document.createElement('div');
    this._shell.className = 'bbx-shell';
    this.iframe = document.createElement('iframe');
    this.iframe.allowFullscreen = true;
    this.iframe.setAttribute(
      'allow',
      'accelerometer; camera; encrypted-media; display-capture; geolocation; gyroscope; microphone; midi; clipboard-read; clipboard-write; web-share; fullscreen'
    );
    this.iframe.setAttribute(
      'sandbox',
      'allow-same-origin allow-forms allow-scripts allow-top-navigation allow-top-navigation-by-user-activation allow-storage-access-by-user-activation allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock'
    );

    const style = document.createElement('style');
    style.textContent = `
      :host {
        display: block;
        margin: 0;
        padding: 0;
        overflow: hidden;
        outline: none;
        position: relative;
      }
      :host(:focus), :host(:focus-visible) {
        outline: none;
      }
      .bbx-shell {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }
      iframe {
        border: none;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        display: block;
        outline: none;
        position: absolute;
        inset: 0;
      }
      iframe:focus, iframe:focus-visible {
        outline: none;
      }
      .bbx-layer {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }
      .bbx-layer[data-space="toast"] {
        inset: auto 0 0 auto;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 12px;
        padding: 12px;
        max-width: min(420px, 100%);
      }
      .bbx-augment {
        box-sizing: border-box;
        color: #fff;
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .bbx-augment[data-interactive="true"] {
        pointer-events: auto;
      }
      .bbx-augment-surface {
        position: absolute;
        inset: 0;
      }
      .bbx-augment-content {
        width: 100%;
        height: 100%;
      }
      .bbx-augment-panel,
      .bbx-augment-sidebar,
      .bbx-augment-toolbar,
      .bbx-augment-note,
      .bbx-augment-badge,
      .bbx-augment-custom,
      .bbx-augment-toast {
        background: rgba(24, 24, 27, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 12px;
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
        padding: 12px;
        backdrop-filter: blur(10px);
      }
      .bbx-augment-toolbar {
        border-radius: 999px;
      }
      .bbx-highlight-box {
        position: absolute;
        border: 2px solid rgba(250, 204, 21, 0.95);
        background: rgba(250, 204, 21, 0.18);
        border-radius: 8px;
        box-shadow: 0 0 0 1px rgba(17, 24, 39, 0.18) inset;
      }
      .bbx-highlight-box[data-tone="info"] {
        border-color: rgba(59, 130, 246, 0.95);
        background: rgba(59, 130, 246, 0.18);
      }
      .bbx-highlight-box[data-tone="success"] {
        border-color: rgba(34, 197, 94, 0.95);
        background: rgba(34, 197, 94, 0.18);
      }
      .bbx-highlight-box[data-tone="danger"] {
        border-color: rgba(239, 68, 68, 0.95);
        background: rgba(239, 68, 68, 0.18);
      }
    `;
    this._augmentRoots = {
      page: this._createAugmentLayer('page'),
      viewport: this._createAugmentLayer('viewport'),
      chrome: this._createAugmentLayer('chrome'),
      session: this._createAugmentLayer('session'),
      toast: this._createAugmentLayer('toast'),
    };
    this._shell.append(
      this.iframe,
      this._augmentRoots.page,
      this._augmentRoots.viewport,
      this._augmentRoots.chrome,
      this._augmentRoots.session,
      this._augmentRoots.toast,
    );
    this.shadowRoot.append(style, this._shell);

    this._requestSeq = 0;
    this._pending = new Map();
    this._apiMethods = [];
    this._isReady = false;
    this._usable = false;
    this._readyPromise = Promise.resolve(true);
    this._initPingTimer = null;
    this._transportMode = 'unknown';
    this._legacyTabsCache = [];

    // Iframe connection retry state
    this._iframeRetryCount = 0;
    this._iframeRetryMax = 5;
    this._iframeRetryPingThreshold = 30; // pings (1s each) before retry — covers ~90s cold starts
    this._initPingCount = 0;
    this._reconnectStopped = false;
    this._silentRecoveryUsed = false;
    this._silentRecoveryParam = 'bbx_embed_retry';

    // Mid routing durability handshake state
    this._routingMid = '';
    this._midStorageKey = 'bbx.embedder.mid';
    this._midSyncAcked = false;
    this._midSyncTimer = null;
    this._midSyncAttempt = 0;
    this._midSyncMaxAttempts = 90;
    this._midSyncIntervalMs = 1000;

    // UI config sync state (embedder → BrowserBox iframe)
    this._uiSyncAcked = false;
    this._serverPolicySnapshot = null;
    this._policySnapshot = this._resolvePolicySnapshot();
    this._capabilityMap = this._buildCapabilityMap(this._policySnapshot);
    this._policySnapshotCache = {
      source: null,
      value: null,
    };
    this._eventSubscribers = new Set();
    this._eventSeq = 0;
    this._augmentRegistry = new Map();
    this._pageAugmentRefreshScheduled = false;
    this._resizeObserver = null;
    this._lastError = null;
    this._frameBootstrapTimer = null;
    this._frameBootstrapInFlight = null;
    this._frameBootstrapRetryTimer = null;
    this._frameBootstrapRetryRemaining = 0;
    this._frameBootstrapEpoch = 0;
    this._iframeViewportKickTimer = null;
    this._lastResizeWidth = -1;
    this._lastResizeHeight = -1;
    this._visibilityPollTimer = null;
    this._lastEffectiveVisibility = null;
    this._deferredVisibilityRecheckTimer = null;

    this._boundMessage = this._handleMessage.bind(this);
    this._boundLoad = this._handleLoad.bind(this);
    this._boundResize = this._handleResize.bind(this);
    this._boundVisibilityChange = () => this._handleResumeTrigger('document-visibility');
    this._boundPageShow = () => this._handleResumeTrigger('page-show');
    this._boundWindowFocus = () => this._handleResumeTrigger('window-focus');
    this._resetReadyPromise();
    this.tabs = createTabsNamespace(this);
    this.page = createPageNamespace(this);
    this.capture = createCaptureNamespace(this);
    this.augment = createAugmentApi(this);
    this.policy = createPolicyNamespace(this);
    this.session = createSessionFacade(this);
  }

  connectedCallback() {
    window.addEventListener('message', this._boundMessage);
    window.addEventListener('resize', this._boundResize);
    window.addEventListener('pageshow', this._boundPageShow);
    window.addEventListener('focus', this._boundWindowFocus);
    document.addEventListener('visibilitychange', this._boundVisibilityChange);
    this.iframe.addEventListener('load', this._boundLoad);
    if (!this._resizeObserver && typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(() => this._handleResize());
      this._resizeObserver.observe(this);
    }
    this._startVisibilityPolling();
    this.updateIframe();
  }

  disconnectedCallback() {
    window.removeEventListener('message', this._boundMessage);
    window.removeEventListener('resize', this._boundResize);
    window.removeEventListener('pageshow', this._boundPageShow);
    window.removeEventListener('focus', this._boundWindowFocus);
    document.removeEventListener('visibilitychange', this._boundVisibilityChange);
    this.iframe.removeEventListener('load', this._boundLoad);
    this._resizeObserver?.disconnect?.();
    this._resizeObserver = null;
    this._invalidateFrameBootstrap('disconnected');
    if (this._iframeViewportKickTimer) {
      clearTimeout(this._iframeViewportKickTimer);
      this._iframeViewportKickTimer = null;
    }
    if (this._deferredVisibilityRecheckTimer) {
      clearTimeout(this._deferredVisibilityRecheckTimer);
      this._deferredVisibilityRecheckTimer = null;
    }
    this._stopVisibilityPolling();
    this._stopInitPing();
    this._stopMidSync();
    this._rejectPending(createBrowserBoxError('browserbox-webview disconnected.', {
      code: ERROR_CODES.TRANSPORT,
      retriable: true,
      status: 503,
    }));
    this._setUsable(false, 'disconnected');
    this._emitBrowserBoxEvent('disconnected', {});
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) {
      return;
    }
    if (name === 'login-link') {
      this._isReady = false;
      this._apiMethods = [];
      this._transportMode = 'unknown';
      this._legacyTabsCache = [];
      this._iframeRetryCount = 0;
      this._initPingCount = 0;
      this._reconnectStopped = false;
      this._silentRecoveryUsed = false;
      this._resetReadyPromise();
      this._invalidateFrameBootstrap('login-link-changed');
      this._rejectPending(createBrowserBoxError('browserbox-webview source changed.', {
        code: ERROR_CODES.TRANSPORT,
        retriable: true,
        status: 503,
      }));
      this._emitBrowserBoxEvent('disconnected', {
        reason: 'login-link-changed',
      });
      this._updateIframeSrcFromAttribute(name);
      this._startMidSync('login-link-changed');
      return;
    }
    if (name === 'width' || name === 'height') {
      this._applyHostDimensions();
      return;
    }
    if (name === 'ui-visible' || name === 'allow-user-toggle-ui') {
      this._sendUISync('attribute-changed');
      return;
    }
    if (name === 'policy' || name === 'interaction-mode' || name === 'chrome' || name === 'augment-root' || name === 'capture') {
      if (name === 'chrome') {
        this._sendUISync('chrome-attribute-changed');
      }
      this._refreshPolicyState('attribute-changed');
    }
  }

  _resetReadyPromise() {
    this._readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
  }

  _setReady() {
    if (!this._isReady) {
      this._isReady = true;
      this._setUsable(true, 'ready');
      this._iframeRetryCount = 0;
      this._reconnectStopped = false;
      this._stopInitPing();
      if (typeof this._resolveReady === 'function') {
        this._resolveReady(true);
      }
    }
    this._invalidateFrameBootstrap('ready');
    this._scheduleFrameBootstrap('ready', 120);
    this._startFrameBootstrapRetries('ready');
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }

  _setUsable(next, reason = '') {
    const usable = Boolean(next);
    if (this._usable === usable) return;
    this._usable = usable;
    this._emitBrowserBoxEvent('usability-changed', {
      usable,
      reason,
    });
  }

  _createAugmentLayer(space) {
    const layer = document.createElement('div');
    layer.className = 'bbx-layer';
    layer.dataset.space = space;
    return layer;
  }

  _handleResize() {
    const w = this.clientWidth;
    const h = this.clientHeight;
    if (w === this._lastResizeWidth && h === this._lastResizeHeight) return;
    this._lastResizeWidth = w;
    this._lastResizeHeight = h;
    this._emitBrowserBoxEvent('viewport.resized', {
      width: w,
      height: h,
    });
    this._schedulePageAugmentRefresh();
    this._sendViewportReset('viewport-resized');
  }

  _stopFrameBootstrap() {
    if (this._frameBootstrapTimer) {
      clearTimeout(this._frameBootstrapTimer);
      this._frameBootstrapTimer = null;
    }
  }

  _stopFrameBootstrapRetries() {
    if (this._frameBootstrapRetryTimer) {
      clearTimeout(this._frameBootstrapRetryTimer);
      this._frameBootstrapRetryTimer = null;
    }
    this._frameBootstrapRetryRemaining = 0;
  }

  _invalidateFrameBootstrap(_reason = 'state-changed') { // eslint-disable-line no-unused-vars
    this._frameBootstrapEpoch += 1;
    this._stopFrameBootstrap();
    this._stopFrameBootstrapRetries();
    return this._frameBootstrapEpoch;
  }

  _kickIframeViewportGeometry() {
    if (!this.iframe?.isConnected) {
      return false;
    }
    const width = Math.max(0, Math.floor(this.clientWidth));
    const height = Math.max(0, Math.floor(this.clientHeight));
    if (width <= 0 || height <= 0) {
      return false;
    }
    // Skip the +1px kick when using percentage sizing (embedded mode) —
    // the kick triggers parent relayout → ResizeObserver → infinite loop.
    const widthAttr = this.getAttribute('width') || '100%';
    const heightAttr = this.getAttribute('height') || '100%';
    if (!/^\d+$/.test(widthAttr) || !/^\d+$/.test(heightAttr)) {
      return false;
    }
    if (this._iframeViewportKickTimer) {
      clearTimeout(this._iframeViewportKickTimer);
      this._iframeViewportKickTimer = null;
    }
    const previousWidth = this.iframe.style.width;
    const previousHeight = this.iframe.style.height;
    this.iframe.style.width = `${width + 1}px`;
    this.iframe.style.height = `${height + 1}px`;
    this._iframeViewportKickTimer = setTimeout(() => {
      this._iframeViewportKickTimer = null;
      this.iframe.style.width = previousWidth;
      this.iframe.style.height = previousHeight;
    }, 40);
    return true;
  }

  _isEffectivelyVisible() {
    if (!this.isConnected) {
      return false;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return false;
    }
    if (this.clientWidth <= 0 || this.clientHeight <= 0) {
      return false;
    }
    let node = this;
    while (node && node instanceof Element) {
      const style = window.getComputedStyle(node);
      if (
        style.display === 'none'
        || style.visibility === 'hidden'
        || Number(style.opacity) === 0
      ) {
        return false;
      }
      node = node.parentElement;
    }
    return true;
  }

  _scheduleVisibilityWake(reason = 'became-visible') {
    console.info('[browserbox-webview] visibility wake scheduled', { reason });
    this._invalidateFrameBootstrap(`visibility-wake:${reason}`);
    this._scheduleFrameBootstrap(reason, 50);
    this._startFrameBootstrapRetries(reason, {
      attempts: 6,
      initialDelayMs: 180,
      intervalMs: 650,
    });
  }

  _checkEffectiveVisibility() {
    const nextVisible = this._isEffectivelyVisible();
    const previousVisible = this._lastEffectiveVisibility;
    this._lastEffectiveVisibility = nextVisible;
    if (previousVisible === false && nextVisible === true) {
      this._scheduleVisibilityWake('became-visible');
    }
  }

  _handleResumeTrigger(reason = 'document-visibility') {
    const wasVisible = this._lastEffectiveVisibility;
    this._checkEffectiveVisibility();
    if (wasVisible === true && this._lastEffectiveVisibility === true) {
      this._scheduleVisibilityWake(reason);
    }
    // If we transitioned hidden→visible, _checkEffectiveVisibility already
    // scheduled the wake.  But if the poll timer hasn't run yet (fast
    // minimize/restore), wasVisible might still be true from before the hide
    // while _lastEffectiveVisibility just flipped to true inside the check.
    // The guard above covers that (both true → wake). For the remaining edge
    // case where an external caller (host window manager) fires this while
    // the component was hidden and is now visible, always force a deferred
    // recheck so layout can settle.
    if (!this._deferredVisibilityRecheckTimer) {
      this._deferredVisibilityRecheckTimer = setTimeout(() => {
        this._deferredVisibilityRecheckTimer = null;
        this._checkEffectiveVisibility();
      }, 120);
    }
  }

  _startVisibilityPolling() {
    this._stopVisibilityPolling();
    this._lastEffectiveVisibility = this._isEffectivelyVisible();
    this._visibilityPollTimer = setInterval(() => {
      this._checkEffectiveVisibility();
    }, 250);
  }

  _stopVisibilityPolling() {
    if (this._visibilityPollTimer) {
      clearInterval(this._visibilityPollTimer);
      this._visibilityPollTimer = null;
    }
    this._lastEffectiveVisibility = null;
  }

  _scheduleFrameBootstrap(reason = 'lifecycle', delayMs = 120) {
    this._stopFrameBootstrap();
    this._frameBootstrapTimer = setTimeout(() => {
      this._frameBootstrapTimer = null;
      void this._bootstrapActiveTabFrame(reason);
    }, Math.max(0, delayMs));
  }

  _startFrameBootstrapRetries(reason = 'ready', {
    attempts = 24,
    initialDelayMs = 400,
    intervalMs = 800,
  } = {}) {
    this._stopFrameBootstrapRetries();
    this._frameBootstrapRetryRemaining = Math.max(0, attempts);
    if (this._frameBootstrapRetryRemaining === 0) {
      return;
    }
    const run = () => {
      if (!this.isConnected || this._frameBootstrapRetryRemaining <= 0) {
        this._stopFrameBootstrapRetries();
        return;
      }
      const attempt = (attempts - this._frameBootstrapRetryRemaining) + 1;
      this._frameBootstrapRetryRemaining -= 1;
      void this._bootstrapActiveTabFrame(`${reason}-retry-${attempt}`);
      if (this._frameBootstrapRetryRemaining <= 0) {
        this._frameBootstrapRetryTimer = null;
        return;
      }
      this._frameBootstrapRetryTimer = setTimeout(run, Math.max(250, intervalMs));
    };
    this._frameBootstrapRetryTimer = setTimeout(run, Math.max(0, initialDelayMs));
  }

  async _bootstrapActiveTabFrame(reason = 'lifecycle') {
    if (this._frameBootstrapInFlight) {
      return this._frameBootstrapInFlight;
    }
    this._frameBootstrapInFlight = (async () => {
      const bootstrapEpoch = this._frameBootstrapEpoch;
      try {
        if (!this.isConnected) {
          return false;
        }
        if (this.clientWidth <= 0 || this.clientHeight <= 0) {
          return false;
        }
        const ready = await this._ensureReadyForApi();
        if (!ready) {
          return false;
        }
        if (this._transportMode === 'unknown') {
          await this._resolveTransport();
        }
        const activeTab = await this._getActiveTabInfo(null).catch(() => null);
        const tabId = activeTab?.id || activeTab?.targetId || null;
        if (!tabId) {
          return false;
        }
        if (bootstrapEpoch !== this._frameBootstrapEpoch) {
          return false;
        }
        const kickedViewportGeometry = this._kickIframeViewportGeometry();
        if (kickedViewportGeometry) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        if (bootstrapEpoch !== this._frameBootstrapEpoch) {
          return false;
        }
        const currentTab = await this._getActiveTabInfo(null).catch(() => null);
        const currentTabId = currentTab?.id || currentTab?.targetId || null;
        if (!currentTabId || currentTabId !== tabId) {
          return false;
        }
        const forcedViewportReset = this._sendViewportReset(`frame-bootstrap:${reason}`);
        if (forcedViewportReset) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        if (bootstrapEpoch !== this._frameBootstrapEpoch) {
          return false;
        }
        const activeAfterReset = await this._getActiveTabInfo(null).catch(() => null);
        const activeAfterResetId = activeAfterReset?.id || activeAfterReset?.targetId || null;
        if (!activeAfterResetId || activeAfterResetId !== tabId) {
          return false;
        }
        if (this._transportMode === 'legacy') {
          await this._legacyCall('switchToTabById', [tabId]);
        } else {
          await this._request('bbx-api-call', {
            method: 'switchToTabById',
            args: [tabId],
          }, {
            timeoutMs: Math.min(this.requestTimeoutMs, 5000),
          });
        }
        console.info('[browserbox-webview] bootstrapped active tab frame', {
          reason,
          tabId,
          transport: this._transportMode,
          kickedViewportGeometry,
          forcedViewportReset,
        });
        return true;
      } catch (error) {
        console.warn('[browserbox-webview] active tab frame bootstrap failed', {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        this._frameBootstrapInFlight = null;
      }
    })();
    return this._frameBootstrapInFlight;
  }

  async _withRetry(task, {
    attempts = 3,
    baseDelayMs = 250,
    maxDelayMs = 1500,
    shouldRetry = () => false,
  } = {}) {
    let attempt = 0;
    let lastError = null;
    while (attempt < attempts) {
      try {
        return await task(attempt);
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt >= attempts || !shouldRetry(error, attempt)) {
          throw error;
        }
        const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError || createBrowserBoxError('browserbox-webview retry failed.', {
      code: ERROR_CODES.INTERNAL,
      status: 500,
    });
  }

  _isRetryableApiError(error) {
    const message = String(error?.message || '').toLowerCase();
    return (
      error?.retriable === true
      || error?.code === ERROR_CODES.NOT_READY
      || error?.code === ERROR_CODES.TIMEOUT
      || error?.code === ERROR_CODES.TRANSPORT
      || message.includes('timed out')
      || message.includes('not ready')
      || message.includes('disconnected')
      || message.includes('reconnect stopped')
    );
  }

  _rememberError(error) {
    if (!error) {
      this._lastError = null;
      return;
    }
    this._lastError = {
      code: typeof error.code === 'string' ? error.code : ERROR_CODES.INTERNAL,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  _normalizeRemoteError(error, context = {}) {
    if (error instanceof BrowserBoxError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error || 'Unknown BrowserBox error');
    const lower = message.toLowerCase();
    let code = ERROR_CODES.INTERNAL;
    let status = 500;
    let retriable = false;

    if (lower.includes('timed out')) {
      code = ERROR_CODES.TIMEOUT;
      status = 504;
      retriable = true;
    } else if (lower.includes('not ready') || lower.includes('selection is already active')) {
      code = ERROR_CODES.NOT_READY;
      status = 409;
      retriable = true;
    } else if (lower.includes('already exists')) {
      code = ERROR_CODES.CONFLICT;
      status = 409;
    } else if (lower.includes('unknown api method') || lower.includes('no legacy fallback')) {
      code = ERROR_CODES.UNSUPPORTED;
      status = 501;
    } else if (
      lower.includes('requires a non-empty')
      || lower.includes('requires an object')
      || lower.includes('requires target.selector')
      || lower.includes('requires selection.selector')
      || lower.includes('requires data.method')
      || lower.includes('requires payload')
    ) {
      code = ERROR_CODES.INVALID_ARGUMENT;
      status = 400;
    } else if (
      lower.includes('does not exist')
      || lower.includes('no target tab')
      || lower.includes('no active tab')
    ) {
      code = ERROR_CODES.NOT_FOUND;
      status = 404;
    } else if (lower.includes('does not support')) {
      code = ERROR_CODES.UNSUPPORTED;
      status = 501;
    } else if (lower.includes('disconnected') || lower.includes('iframe')) {
      code = ERROR_CODES.TRANSPORT;
      status = 503;
      retriable = true;
    }

    return createBrowserBoxError(message, {
      code,
      status,
      retriable,
      ...context,
      ...(error instanceof Error && error.cause !== undefined ? { cause: error.cause } : {}),
    });
  }

  _handleLoad() {
    if (this._reconnectStopped) {
      return;
    }
    const needsReset = this._isReady;
    this._isReady = false;
    this._apiMethods = [];
    this._transportMode = 'unknown';
    this._legacyTabsCache = [];
    this._initPingCount = 0;
    if (needsReset) {
      this._iframeRetryCount = 0;
      this._resetReadyPromise();
    }
    this._midSyncAcked = false;
    this._uiSyncAcked = false;
    this._startMidSync('iframe-load');
    this._sendUISync('iframe-load');
    this._startInitPing();
  }

  _startInitPing() {
    if (this._reconnectStopped) {
      return;
    }
    this._stopInitPing();
    this._initPingCount = 0;
    this._postRaw({ type: 'init' });
    this._initPingTimer = setInterval(() => {
      if (this._reconnectStopped) {
        this._stopInitPing();
        return;
      }
      if (this._isReady) {
        this._stopInitPing();
        return;
      }
      this._initPingCount += 1;
      if (this._initPingCount >= this._iframeRetryPingThreshold) {
        if (this._iframeRetryCount < this._iframeRetryMax) {
          this._retryIframeLoad();
          return;
        }
        if (this._attemptSilentRecovery('iframe-unresponsive')) {
          return;
        }
        this.stopReconnectAttempts('iframe-unresponsive');
        return;
      }
      this._postRaw({ type: 'init' });
    }, 1000);
  }

  _retryIframeLoad() {
    this._stopInitPing();
    this._iframeRetryCount += 1;
    const src = this.iframe.src;
    if (!src) return;
    const delay = Math.min(2000 * this._iframeRetryCount, 8000);
    console.log(
      `[browserbox-webview] iframe not responsive after ${this._iframeRetryPingThreshold}s, `
      + `retry ${this._iframeRetryCount}/${this._iframeRetryMax} in ${delay}ms`
    );
    this._emitBrowserBoxEvent('iframe-retry', {
      attempt: this._iframeRetryCount,
      maxAttempts: this._iframeRetryMax,
      delayMs: delay,
    });
    setTimeout(() => {
      if (this._isReady || this._reconnectStopped) return;
      this._assignIframeSrc(src, '_retryIframeLoad');
    }, delay);
  }

  _assignIframeSrc(nextSrc, reason) {
    const stack = new Error().stack || '(no stack available)';
    debugBrowserBoxWebview('[DEBUG][SRC_ASSIGN]', {
      reason,
      currentSrc: this.iframe.src,
      nextSrc,
      stack,
    });
    this.iframe.src = nextSrc;
  }

  _normalizeUrl(url) {
    if (typeof url !== 'string' || url.length === 0) return '';
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return url;
    }
  }

  _attemptSilentRecovery(reason) {
    if (this._silentRecoveryUsed) {
      return false;
    }
    const currentSrc = this._normalizeUrl(this.iframe.src || this.getAttribute('login-link'));
    if (!currentSrc) {
      return false;
    }

    let nextSrc;
    try {
      const parsed = new URL(currentSrc, window.location.href);
      const existingAttempt = Number(parsed.searchParams.get(this._silentRecoveryParam) || 0);
      if (!Number.isFinite(existingAttempt) || existingAttempt >= 1) {
        return false;
      }
      parsed.searchParams.set(this._silentRecoveryParam, String(existingAttempt + 1));
      // Cache-bust to avoid stale iframe boot assets after session/token rotation.
      parsed.searchParams.set('bbx_recover_t', String(Date.now()));
      nextSrc = parsed.href;
    } catch {
      return false;
    }

    this._silentRecoveryUsed = true;
    this._isReady = false;
    this._apiMethods = [];
    this._transportMode = 'unknown';
    this._legacyTabsCache = [];
    this._iframeRetryCount = 0;
    this._initPingCount = 0;
    this._midSyncAcked = false;
    this._reconnectStopped = false;
    this._resetReadyPromise();
    this._rejectPending(createBrowserBoxError(`browserbox-webview silent recovery (${reason}).`, {
      code: ERROR_CODES.TRANSPORT,
      retriable: true,
      status: 503,
      reason,
    }));

    console.info('[browserbox-webview] attempting one-shot silent recovery reload', {
      reason,
      nextSrc,
    });
    this._assignIframeSrc(nextSrc, 'silent-recovery');
    return true;
  }

  _updateIframeSrcFromAttribute(trigger) {
    const loginLink = this.getAttribute('login-link');
    if (!loginLink) return;
    this._refreshRoutingMid(loginLink);
    const normalizedCurrent = this._normalizeUrl(this.iframe.src);
    const normalizedNext = this._normalizeUrl(loginLink);
    if (normalizedCurrent === normalizedNext) {
      return;
    }
    this._assignIframeSrc(loginLink, trigger);
  }

  _applyHostDimensions() {
    const width = this.getAttribute('width') || '100%';
    const height = this.getAttribute('height') || '100%';
    this.style.width = /^\d+$/.test(width) ? `${width}px` : width;
    this.style.height = /^\d+$/.test(height) ? `${height}px` : height;
  }

  _stopInitPing() {
    if (this._initPingTimer) {
      clearInterval(this._initPingTimer);
      this._initPingTimer = null;
    }
  }

  _normalizeMid(value) {
    const mid = String(value || '').trim();
    return /^[A-Za-z0-9-]{6,64}$/.test(mid) ? mid : '';
  }

  _refreshRoutingMid(loginLink = this.getAttribute('login-link')) {
    let storageKey = this._midStorageKey;
    let midFromLogin = '';
    try {
      const parsed = new URL(loginLink || '', window.location.href);
      storageKey = `bbx.embedder.mid:${parsed.origin}`;
      midFromLogin = this._normalizeMid(parsed.searchParams.get('mid'));
    } catch {
      // Keep fallback values when login-link is not parseable.
    }

    let persistedMid = '';
    try {
      persistedMid = this._normalizeMid(window.localStorage?.getItem?.(storageKey));
    } catch {
      // Storage may be blocked in some embedding contexts.
    }

    const resolvedMid = midFromLogin || persistedMid || this._routingMid;
    this._midStorageKey = storageKey;
    this._routingMid = resolvedMid || '';

    if (midFromLogin) {
      try {
        window.localStorage?.setItem?.(storageKey, midFromLogin);
      } catch {
        // Storage writes are best-effort only.
      }
    }

    if (this._routingMid) {
      this.setAttribute('routing-mid', this._routingMid);
    } else {
      this.removeAttribute('routing-mid');
    }
    if (this._routingMid) {
      console.info('[bbx-mid] routing mid resolved', {
        mid: this._routingMid,
        source: midFromLogin ? 'login-link' : (persistedMid ? 'storage' : 'memory'),
      });
    } else {
      console.info('[bbx-mid] no routing mid resolved');
    }
    return this._routingMid;
  }

  _postMidSync(reason = '') {
    const mid = this._refreshRoutingMid();
    if (!mid || !this.iframe.contentWindow) {
      return false;
    }
    // Mid-sync messages use '*' targetOrigin because the iframe may
    // still be navigating to the BBX origin (from parent origin).
    // These messages contain only the routing mid, not sensitive data.
    try {
      this.iframe.contentWindow.postMessage({
        type: 'bbx-mid-sync',
        data: {
          mid,
          reason,
          attempt: this._midSyncAttempt,
        },
      }, '*');
    } catch (error) {
      console.warn('[bbx-mid] postMessage failed', { error: error.message });
      return false;
    }
    console.info('[bbx-mid] sent sync', {
      mid,
      reason,
      attempt: this._midSyncAttempt,
    });
    return true;
  }

  _startMidSync(reason = 'start') {
    this._stopMidSync();
    this._midSyncAcked = false;
    this._midSyncAttempt = 0;
    if (!this._postMidSync(reason)) {
      return;
    }
    this._midSyncAttempt = 1;
    this._midSyncTimer = setInterval(() => {
      if (this._midSyncAcked) {
        this._stopMidSync();
        return;
      }
      if (this._midSyncAttempt >= this._midSyncMaxAttempts) {
        this._stopMidSync();
        console.warn('[bbx-mid] sync timeout', {
          attempts: this._midSyncAttempt,
          mid: this._routingMid,
        });
        this.dispatchEvent(new CustomEvent('mid-sync-timeout', {
          detail: {
            attempts: this._midSyncAttempt,
            mid: this._routingMid,
          },
        }));
        this._setUsable(false, 'mid-sync-timeout');
        return;
      }
      this._midSyncAttempt += 1;
      this._postMidSync('retry');
    }, this._midSyncIntervalMs);
  }

  _stopMidSync() {
    if (this._midSyncTimer) {
      clearInterval(this._midSyncTimer);
      this._midSyncTimer = null;
    }
  }

  _resolveUIConfig() {
    const parseBool = (v, fallback) => {
      if (v === null || v === undefined) return fallback;
      const raw = String(v).trim().toLowerCase();
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      return fallback;
    };
    const chromeMode = String(this.getAttribute('chrome') || 'default').trim().toLowerCase();
    const chromeVisibleByMode = chromeMode === 'none' ? false : true;
    return {
      uiVisible: parseBool(this.getAttribute('ui-visible'), chromeVisibleByMode),
      allowUserToggleUI: parseBool(this.getAttribute('allow-user-toggle-ui'), true),
      chromeMode,
    };
  }

  _resolveLocalPolicySnapshot() {
    const interactionModeRaw = this.getAttribute('interaction-mode') || 'full';
    const interactionMode = String(interactionModeRaw).trim().toLowerCase();
    const preset = INTERACTION_MODE_PRESETS[interactionMode] || INTERACTION_MODE_PRESETS.full;
    let capabilityOverride = {};
    const policyRaw = this.getAttribute('policy');
    if (policyRaw) {
      try {
        const parsed = JSON.parse(policyRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          capabilityOverride = extractApiCapabilities(parsed);
        } else {
          console.error('[browserbox-webview] policy attribute must decode to an object.', {
            policy: policyRaw,
          });
        }
      } catch (error) {
        console.error('[browserbox-webview] failed to parse policy attribute.', {
          policy: policyRaw,
          error,
        });
      }
    }
    const captureMode = String(this.getAttribute('capture') || 'snapshot').trim().toLowerCase();
    const captureOverride = {
      capture: {
        frame: captureMode !== 'off',
        viewport: captureMode !== 'off',
        stream: captureMode === 'sampled',
      },
    };
    const localOverride = mergePolicyTree(
      clonePolicyTree(POLICY_DEFAULTS),
      {
        ...capabilityOverride,
        capture: {
          ...(capabilityOverride.capture || {}),
          ...captureOverride.capture,
        },
      },
    );
    const capabilities = mergePolicyTree(
      mergePolicyTree(clonePolicyTree(POLICY_DEFAULTS), preset),
      localOverride,
    );
    return createLocalPolicySnapshot(capabilities, {
      baselineId: `browserbox-webview-${interactionMode}`,
      featureControls: {
        chromeMode: String(this.getAttribute('chrome') || 'default').trim().toLowerCase(),
        augmentRoot: String(this.getAttribute('augment-root') || 'open').trim().toLowerCase(),
        captureMode,
      },
    });
  }

  _resolvePolicySnapshot() {
    return mergePolicySnapshots(this._serverPolicySnapshot, this._resolveLocalPolicySnapshot());
  }

  _buildCapabilityMap(policySnapshot) {
    const policyCapabilities = flattenPolicyTree(extractApiCapabilities(policySnapshot));
    const resolved = {};
    for (const [capability, allowedByPolicy] of Object.entries(policyCapabilities)) {
      resolved[capability] = Boolean(allowedByPolicy) && Boolean(IMPLEMENTED_CAPABILITIES[capability]);
    }
    return resolved;
  }

  _invalidatePolicySnapshotCache() {
    this._policySnapshotCache.source = null;
    this._policySnapshotCache.value = null;
  }

  _getPolicySnapshotView() {
    if (this._policySnapshotCache.source === this._policySnapshot && this._policySnapshotCache.value) {
      return this._policySnapshotCache.value;
    }

    const snapshotView = createPolicySnapshotView(this._policySnapshot);
    this._policySnapshotCache.source = this._policySnapshot;
    this._policySnapshotCache.value = snapshotView;
    return snapshotView;
  }

  _refreshPolicyState(reason = 'refresh') {
    const previousPolicy = JSON.stringify(this._policySnapshot);
    const previousCapabilities = JSON.stringify(this._capabilityMap);
    const nextPolicySnapshot = this._resolvePolicySnapshot();
    const nextCapabilityMap = this._buildCapabilityMap(nextPolicySnapshot);

    if (
      previousPolicy === JSON.stringify(nextPolicySnapshot)
      && previousCapabilities === JSON.stringify(nextCapabilityMap)
    ) {
      return;
    }

    this._policySnapshot = nextPolicySnapshot;
    this._capabilityMap = nextCapabilityMap;
    this._invalidatePolicySnapshotCache();
    this._emitBrowserBoxEvent('policy.changed', {
      reason,
      policy: this._getPolicySnapshotView(),
      capabilities: { ...this._capabilityMap },
    });
  }

  _capabilitiesForMethod(method, args = []) {
    if (method === 'captureFrame') {
      const scope = String(args?.[0]?.scope || 'frame').trim().toLowerCase();
      return [scope === 'viewport' ? 'capture.viewport' : 'capture.frame'];
    }
    const requirements = METHOD_CAPABILITY_MAP[method];
    return Array.isArray(requirements) ? requirements : [];
  }

  _assertCapability(capability) {
    if (this._capabilityMap?.[capability]) {
      return true;
    }
    const detail = {
      error: `Capability denied: ${capability}`,
      policyDenied: {
        action: capability,
        capability,
        reasonCode: 'embed-policy-denied',
        policyId: this._policySnapshot?.policyId || POLICY_ID,
        baselineId: this._policySnapshot?.baselineId || POLICY_BASELINE_ID,
        decisionSchemaVersion: 'embedder-policy/v1',
        source: this._serverPolicySnapshot ? 'server+embedder-policy' : 'embedder-policy',
      },
    };
    this._emitBrowserBoxEvent('policy-denied', detail);
    throw new BrowserBoxPolicyError(capability);
  }

  _isEventAllowed(eventName) {
    if (!this._capabilityMap?.['events.read']) {
      return false;
    }
    const requiredCapability = EVENT_CAPABILITY_RULES[eventName];
    return !requiredCapability || Boolean(this._capabilityMap?.[requiredCapability]);
  }

  _emitBrowserBoxEvent(eventName, detail = {}) {
    const eventNames = [eventName, ...(EVENT_ALIAS_MAP[eventName] || [])];
    for (const name of eventNames) {
      if (!this._isEventAllowed(name)) {
        continue;
      }
      const eventDetail = detail && typeof detail === 'object' ? { ...detail } : detail;
      this.dispatchEvent(new CustomEvent(name, { detail: eventDetail }));
      this._pushEventRecord(name, eventDetail);
    }
    if (
      eventName === 'page.navigated'
      || eventName === 'page.load.stopped'
      || eventName === 'did-navigate'
      || eventName === 'did-stop-loading'
      || eventName === 'viewport.resized'
    ) {
      this._schedulePageAugmentRefresh();
    }
  }

  _pushEventRecord(type, detail) {
    const tabId = this._normalizeTabId(detail);
    const record = {
      id: `bbx-event-${++this._eventSeq}`,
      type,
      detail,
      timestamp: new Date().toISOString(),
      sessionId: this._routingMid || null,
      ...(tabId ? { tabId } : {}),
    };
    for (const subscriber of this._eventSubscribers) {
      if (subscriber.closed || !subscriber.filter(record)) {
        continue;
      }
      if (subscriber.resolve) {
        const resolve = subscriber.resolve;
        subscriber.resolve = null;
        resolve({ value: record, done: false });
        continue;
      }
      if (subscriber.queue.length >= subscriber.maxQueue) {
        subscriber.queue.shift();
      }
      subscriber.queue.push(record);
    }
  }

  _schedulePageAugmentRefresh() {
    if (this._pageAugmentRefreshScheduled) {
      return;
    }
    this._pageAugmentRefreshScheduled = true;
    scheduleMicrotask(() => {
      this._pageAugmentRefreshScheduled = false;
      this._refreshPageAugments().catch((error) => {
        console.warn('[browserbox-webview] failed to refresh page augments', error);
      });
    });
  }

  async _refreshPageAugments() {
    const pageAugments = [...this._augmentRegistry.values()].filter((record) => record.spec.space === 'page');
    if (pageAugments.length === 0) {
      return;
    }
    await Promise.all(pageAugments.map(async (record) => {
      record.resolution = await this._resolveAugmentTarget(record.spec);
      this._renderAugmentRecord(record);
    }));
  }

  _sendUISync(reason = '') {
    if (!this.iframe.contentWindow) return false;
    const config = this._resolveUIConfig();
    this._postRaw({
      type: 'bbx-ui-sync',
      data: {
        uiVisible: config.uiVisible,
        allowUserToggleUI: config.allowUserToggleUI,
        chromeMode: config.chromeMode,
        embedderOrigin: this.embedderOrigin,
        reason,
      },
    });
    return true;
  }

  _sendViewportReset(reason = '') {
    if (!this.iframe.contentWindow) return false;
    this._postRaw({
      type: 'bbx-viewport-reset',
      data: {
        reason,
      },
    });
    return true;
  }

  /**
   * Derive the BrowserBox iframe origin from the login-link URL.
   * This is the origin of the iframe content, used for:
   *   - outbound postMessage targetOrigin (webview → iframe)
   *   - inbound origin validation (iframe → webview)
   * Falls back to '*' during initial load before login-link is set.
   */
  _browserboxOrigin() {
    const loginLink = this.getAttribute('login-link');
    if (loginLink) {
      try {
        return new URL(loginLink).origin;
      } catch {
        // login-link not parseable yet
      }
    }
    return '*';
  }

  _outboundTargetOrigin() {
    return this._browserboxOrigin();
  }

  _validateIncomingOrigin(origin) {
    const expected = this._browserboxOrigin();
    return expected === '*' || origin === expected;
  }

  _normalizeTabId(detail) {
    if (!detail || typeof detail !== 'object') return null;
    const candidates = [detail.id, detail.tabId, detail.targetId];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
    }
    return null;
  }

  _updateLegacyTabCache(detail) {
    const tabId = this._normalizeTabId(detail);
    if (!tabId) return;
    const index = this._legacyTabsCache.findIndex((tab) => this._normalizeTabId(tab) === tabId);
    if (index === -1) return;
    const existing = this._legacyTabsCache[index];
    this._legacyTabsCache[index] = {
      ...existing,
      ...detail,
      index: existing.index ?? detail.index ?? index,
    };
  }

  _addLegacyTabCache(detail) {
    const tabId = this._normalizeTabId(detail);
    if (!tabId) return;
    const existingIndex = this._legacyTabsCache.findIndex((tab) => this._normalizeTabId(tab) === tabId);
    if (existingIndex !== -1) {
      this._updateLegacyTabCache(detail);
      return;
    }
    const index = Number.isInteger(detail.index) ? detail.index : this._legacyTabsCache.length;
    const entry = { ...detail, index };
    this._legacyTabsCache.splice(Math.min(index, this._legacyTabsCache.length), 0, entry);
    this._legacyTabsCache = this._legacyTabsCache.map((tab, i) => ({ ...tab, index: i }));
  }

  _removeLegacyTabCache(detail) {
    const tabId = this._normalizeTabId(detail);
    if (!tabId) return;
    this._legacyTabsCache = this._legacyTabsCache
      .filter((tab) => this._normalizeTabId(tab) !== tabId)
      .map((tab, i) => ({ ...tab, index: i }));
  }

  async _getActiveTabInfo(capability = 'tabs.read') {
    if (capability) {
      this._assertCapability(capability);
    }
    const activeTab = await this._request('getActiveTab', {}).catch(() => null);
    if (activeTab) {
      return normalizeTabInfo({ ...activeTab, active: true }, activeTab.index);
    }
    const tabs = await this.callApi('getTabs').catch(() => []);
    const activeIndex = await this.callApi('getActiveTabIndex').catch(() => -1);
    if (!Array.isArray(tabs) || activeIndex < 0 || activeIndex >= tabs.length) {
      return null;
    }
    return normalizeTabInfo({ ...tabs[activeIndex], active: true }, activeIndex);
  }

  async _getPageText(options = {}) {
    this._assertCapability('page.read');
    try {
      const result = await this.callApi('getPageText', options);
      return extractEvaluateValue(result);
    } catch (error) {
      const message = String(error?.message || '');
      const missingMethod = message.includes('Unknown API method')
        || message.includes('Unknown BrowserBox API method')
        || message.includes('No legacy fallback');
      if (!missingMethod) {
        throw error;
      }
      const mainContentOnly = Boolean(options?.mainContentOnly);
      const targetExpression = mainContentOnly
        ? '(document.querySelector("main, article, [role=\\"main\\"]") || document.body || document.documentElement)'
        : '(document.body || document.documentElement)';
      const result = await this.evaluate(`(() => {
        const root = ${targetExpression};
        if (!root) return "";
        return typeof root.innerText === "string" ? root.innerText : (root.textContent || "");
      })()`, {
        timeoutMs: Number.isFinite(options?.timeoutMs) ? options.timeoutMs : this.requestTimeoutMs,
      });
      return extractEvaluateValue(result);
    }
  }

  async _callApiDirect(method, args = [], requestOptions = {}) {
    if (typeof method !== 'string' || method.trim().length === 0) {
      throwInvalidArgument('browserbox-webview API method requires a non-empty string.');
    }
    if (!Array.isArray(args)) {
      throwInvalidArgument('browserbox-webview API args must be an array.');
    }
    const normalizedMethod = method.trim();
    const ready = await this._ensureReadyForApi();
    if (!ready) {
      throw createBrowserBoxError(`browserbox-webview API method '${normalizedMethod}' called before handshake completed.`, {
        code: ERROR_CODES.NOT_READY,
        retriable: true,
        status: 409,
        method: normalizedMethod,
      });
    }
    for (const capability of this._capabilitiesForMethod(normalizedMethod, args)) {
      this._assertCapability(capability);
    }
    if (this._transportMode === 'unknown') {
      await this._resolveTransport();
    }
    if (this._transportMode === 'legacy') {
      return this._legacyCall(normalizedMethod, args);
    }
    return this._request('bbx-api-call', { method: normalizedMethod, args }, requestOptions);
  }

  async _resolveAugmentTarget(spec) {
    if (!spec?.target || spec.space !== 'page') {
      return null;
    }
    return this._callApiDirect('resolvePageTarget', [spec.target, {
      maxMatches: 12,
    }], {
      timeoutMs: this.requestTimeoutMs,
    });
  }

  _applyAugmentContent(node, content) {
    node.replaceChildren();
    const contentNode = document.createElement('div');
    contentNode.className = 'bbx-augment-content';

    if (isDomNode(content)) {
      contentNode.append(content.cloneNode(true));
    } else if (content && typeof content === 'object' && !Array.isArray(content)) {
      if (content.type === 'html' && typeof content.html === 'string') {
        contentNode.innerHTML = content.html;
      } else if (content.type === 'text' && typeof content.text === 'string') {
        contentNode.textContent = content.text;
      } else if (content.type === 'json') {
        contentNode.textContent = JSON.stringify(content.data, null, 2);
      }
    } else if (content !== undefined && content !== null) {
      contentNode.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    }

    node.append(contentNode);
  }

  _applyAugmentPosition(node, spec, resolution = null) {
    node.style.position = spec.kind === 'toast' ? 'relative' : 'absolute';
    node.style.top = '';
    node.style.right = '';
    node.style.bottom = '';
    node.style.left = '';
    node.style.width = '';
    node.style.height = '';
    node.style.transform = '';
    node.style.maxWidth = '';
    node.style.maxHeight = '';

    if (spec.space === 'page' && spec.kind !== 'highlight') {
      const box = resolution?.matches?.[0];
      if (box) {
        node.style.left = `${box.x}px`;
        node.style.top = `${box.y}px`;
        node.style.width = `${Math.max(40, box.width)}px`;
        node.style.height = `${Math.max(24, box.height)}px`;
        return;
      }
    }

    const position = spec.position || (spec.kind === 'sidebar' ? 'right' : spec.kind === 'toolbar' ? 'top' : 'top-right');

    if (spec.kind === 'sidebar') {
      node.style.top = '0';
      node.style.bottom = '0';
      node.style.width = 'min(360px, 38%)';
      if (position.includes('left')) {
        node.style.left = '0';
      } else {
        node.style.right = '0';
      }
      return;
    }

    if (spec.kind === 'toolbar') {
      node.style.top = '12px';
      node.style.left = '50%';
      node.style.transform = 'translateX(-50%)';
      node.style.width = 'auto';
      node.style.maxWidth = 'calc(100% - 24px)';
      return;
    }

    if (spec.kind === 'toast') {
      node.style.position = 'relative';
      node.style.maxWidth = '100%';
      return;
    }

    node.style.maxWidth = 'min(360px, calc(100% - 24px))';
    if (position.includes('top')) {
      node.style.top = '12px';
    } else if (position.includes('bottom')) {
      node.style.bottom = '12px';
    } else {
      node.style.top = '50%';
      node.style.transform = 'translateY(-50%)';
    }
    if (position.includes('left')) {
      node.style.left = '12px';
    } else if (position.includes('right')) {
      node.style.right = '12px';
    } else {
      node.style.left = '50%';
      node.style.transform = node.style.transform ? `${node.style.transform} translateX(-50%)` : 'translateX(-50%)';
    }
  }

  _applyAugmentStyle(node, spec) {
    node.style.cssText += '';
    if (typeof spec.style === 'string') {
      const tone = spec.style.trim().toLowerCase();
      if (tone && !tone.includes(':')) {
        node.dataset.tone = tone;
      } else if (tone) {
        node.style.cssText += `;${tone}`;
      }
      return;
    }
    if (spec.style && typeof spec.style === 'object' && !Array.isArray(spec.style)) {
      for (const [key, value] of Object.entries(spec.style)) {
        node.style.setProperty(key, String(value));
      }
    }
  }

  _renderHighlightAugment(node, record) {
    const tone = typeof record.spec.style === 'string' ? record.spec.style.trim().toLowerCase() : 'warning';
    const matches = Array.isArray(record.resolution?.matches) ? record.resolution.matches : [];
    node.replaceChildren();
    node.className = 'bbx-augment bbx-augment-surface';
    node.dataset.kind = record.spec.kind;
    node.dataset.space = record.spec.space;
    node.dataset.interactive = String(record.spec.interactive);
    node.style.display = record.spec.visible && matches.length > 0 ? 'block' : 'none';
    for (const box of matches) {
      const highlight = document.createElement('div');
      highlight.className = 'bbx-highlight-box';
      highlight.dataset.tone = tone;
      highlight.style.left = `${box.x}px`;
      highlight.style.top = `${box.y}px`;
      highlight.style.width = `${box.width}px`;
      highlight.style.height = `${box.height}px`;
      node.append(highlight);
    }
  }

  _renderStandardAugment(node, record) {
    node.className = `bbx-augment bbx-augment-${record.spec.kind}`;
    node.dataset.kind = record.spec.kind;
    node.dataset.space = record.spec.space;
    node.dataset.interactive = String(record.spec.interactive);
    node.style.display = record.spec.visible ? '' : 'none';
    this._applyAugmentPosition(node, record.spec, record.resolution);
    this._applyAugmentContent(node, record.spec.content);
    this._applyAugmentStyle(node, record.spec);
  }

  _renderAugmentRecord(record) {
    const root = this._augmentRoots[record.spec.kind === 'toast' ? 'toast' : record.spec.space] || this._augmentRoots.session;
    if (!record.node) {
      record.node = document.createElement('div');
      record.node.dataset.augmentId = record.spec.id;
      root.append(record.node);
    } else if (record.node.parentNode !== root) {
      root.append(record.node);
    }

    if (record.spec.kind === 'highlight') {
      this._renderHighlightAugment(record.node, record);
    } else {
      this._renderStandardAugment(record.node, record);
    }
  }

  async _createAugment(spec) {
    const normalized = normalizeAugmentSpec(spec);
    this._assertCapability('augment.write');
    this._assertCapability(`augment.${normalized.space}`);
    if (this._augmentRegistry.has(normalized.id)) {
      throw createBrowserBoxError(`browserbox-webview augment '${normalized.id}' already exists.`, {
        code: ERROR_CODES.CONFLICT,
        status: 409,
        augmentId: normalized.id,
      });
    }
    const record = {
      spec: normalized,
      resolution: await this._resolveAugmentTarget(normalized),
      node: null,
    };
    this._augmentRegistry.set(normalized.id, record);
    this._renderAugmentRecord(record);
    return Object.freeze({
      id: normalized.id,
      kind: normalized.kind,
      space: normalized.space,
      ...(normalized.position === undefined ? {} : { position: normalized.position }),
      ...(normalized.target === undefined ? {} : { target: cloneJsonValue(normalized.target) }),
      interactive: normalized.interactive,
      visible: normalized.visible,
      remove: () => this._removeAugment(normalized.id),
      update: (patch) => this._updateAugment(normalized.id, patch),
    });
  }

  async _updateAugment(id, patch) {
    const augmentId = assertNonEmptyString(id, 'augment.update(id)');
    this._assertCapability('augment.write');
    const record = this._augmentRegistry.get(augmentId);
    if (!record) {
      throw createBrowserBoxError(`browserbox-webview augment '${augmentId}' does not exist.`, {
        code: ERROR_CODES.NOT_FOUND,
        status: 404,
        augmentId,
      });
    }
    const merged = normalizeAugmentSpec({
      ...record.spec,
      ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
      id: augmentId,
    });
    this._assertCapability(`augment.${merged.space}`);
    record.spec = merged;
    record.resolution = await this._resolveAugmentTarget(merged);
    this._renderAugmentRecord(record);
  }

  async _removeAugment(id) {
    const augmentId = assertNonEmptyString(id, 'augment.remove(id)');
    this._assertCapability('augment.write');
    const record = this._augmentRegistry.get(augmentId);
    if (!record) {
      return false;
    }
    record.node?.remove();
    this._augmentRegistry.delete(augmentId);
    return true;
  }

  async _listAugments() {
    this._assertCapability('augment.read');
    return [...this._augmentRegistry.values()].map((record) => normalizeAugmentInfo(record.spec));
  }

  async select(options = {}) {
    this._assertCapability('select.use');
    const timeoutMs = Number.isFinite(options?.timeoutMs)
      ? Math.max(1000, Math.round(options.timeoutMs))
      : Math.max(this.requestTimeoutMs, 120000);
    const rawSelection = await this._callApiDirect('beginSelect', [options], { timeoutMs });
    return createSelectionHandle(this, rawSelection);
  }

  async _generalizeSelection(rawSelection) {
    return this._callApiDirect('generalizeSelection', [rawSelection], {
      timeoutMs: this.requestTimeoutMs,
    });
  }

  async _extractSelection(target, options = {}) {
    this._assertCapability('select.extract');
    const extractOptions = {
      ...options,
      ...(Number.isInteger(options?.limit) ? { maxItems: options.limit } : {}),
    };
    const result = await this._callApiDirect('extractSelection', [target, extractOptions], {
      timeoutMs: Number.isFinite(options?.timeoutMs) ? options.timeoutMs : this.requestTimeoutMs,
    });
    return normalizeExtractResult(target, result);
  }

  async _previewSelectionPattern(target, previewId) {
    const pattern = target?.selector ? { selector: target.selector } : target;
    const resolution = await this._callApiDirect('resolvePageTarget', [pattern, { maxMatches: 12 }], {
      timeoutMs: this.requestTimeoutMs,
    });
    await this._upsertPreviewAugment(previewId, pattern, resolution);
    return normalizePreviewResult(pattern, resolution);
  }

  async _upsertPreviewAugment(previewId, pattern, resolution) {
    const record = this._augmentRegistry.get(previewId);
    const spec = {
      id: previewId,
      kind: 'highlight',
      space: 'page',
      target: pattern,
      style: 'info',
      interactive: false,
      visible: true,
    };
    if (!record) {
      this._augmentRegistry.set(previewId, {
        spec,
        resolution,
        node: null,
      });
      this._renderAugmentRecord(this._augmentRegistry.get(previewId));
      return;
    }
    record.spec = spec;
    record.resolution = resolution;
    this._renderAugmentRecord(record);
  }

  _handleMessage(event) {
    if (event.source !== this.iframe.contentWindow) {
      return;
    }
    if (!this._validateIncomingOrigin(event.origin)) {
      return;
    }

    const payload = event.data || {};
    if (typeof payload.type !== 'string') {
      return;
    }

    if (payload.type === 'bbx-mid-request') {
      console.info('[bbx-mid] child requested mid');
      this._postMidSync('child-request');
      return;
    }

    if (payload.type === 'bbx-mid-ack') {
      const ackMid = this._normalizeMid(payload.data?.mid ?? payload.mid);
      console.info('[bbx-mid] received ack', {
        ackMid,
        expectedMid: this._routingMid,
      });
      if (this._routingMid && (!ackMid || ackMid === this._routingMid)) {
        this._midSyncAcked = true;
        this._stopMidSync();
        console.info('[bbx-mid] sync established', {
          mid: this._routingMid,
          attempts: Math.max(1, this._midSyncAttempt),
        });
        this.dispatchEvent(new CustomEvent('mid-synced', {
          detail: {
            mid: this._routingMid,
            attempts: Math.max(1, this._midSyncAttempt),
          },
        }));
      } else {
        console.warn('[bbx-mid] ack mid mismatch', {
          ackMid,
          expectedMid: this._routingMid,
        });
      }
      return;
    }

    if (payload.type === 'bbx-ui-request') {
      this._sendUISync('child-request');
      return;
    }

    if (payload.type === 'bbx-ui-ack') {
      this._uiSyncAcked = true;
      return;
    }

    if (payload.type === 'bbx-sos') {
      const incoming = (payload.data && typeof payload.data === 'object')
        ? payload.data
        : {};
      const reasonCode = typeof incoming.reasonCode === 'string' && incoming.reasonCode.length > 0
        ? incoming.reasonCode
        : 'browser-unusable';
      const detail = {
        ...incoming,
        reasonCode,
        iframeOrigin: event.origin,
        routingMid: this._routingMid || '',
        loginLink: this.loginLink || '',
        forwardedAt: Date.now(),
        forwardedBy: 'browserbox-webview',
      };
      this._setUsable(false, `sos:${reasonCode}`);
      this._emitBrowserBoxEvent('sos', detail);
      this._forwardToParent({
        type: 'bbx-sos',
        data: detail,
      });
      return;
    }

    if (payload.requestId && this._pending.has(payload.requestId)) {
      const pending = this._pending.get(payload.requestId);
      clearTimeout(pending.timer);
      this._pending.delete(payload.requestId);
      if (payload.error) {
        const error = this._normalizeRemoteError(payload.error, {
          requestId: payload.requestId,
          requestType: payload.type,
        });
        this._rememberError(error);
        pending.reject(error);
      } else {
        this._rememberError(null);
        pending.resolve(payload.data);
      }
      return;
    }

    if (payload.type === 'tab-api-ready') {
      this._setReady();
      this._emitBrowserBoxEvent('ready', { type: payload.type });
      return;
    }

    if (payload.type === 'bbx-api-ready') {
      if (Array.isArray(payload.data?.methods)) {
        this._apiMethods = payload.data.methods.slice();
        this._transportMode = 'modern';
      }
      if (payload.data?.policy) {
        this._serverPolicySnapshot = normalizePolicyStateSnapshot(payload.data.policy);
        this._refreshPolicyState('server-policy-ready');
      }
      this._setReady();
      this._emitBrowserBoxEvent('api-ready', payload.data || {});
      return;
    }

    if (payload.type === 'bbx-policy-sync') {
      this._serverPolicySnapshot = normalizePolicyStateSnapshot(payload.data?.policy ?? payload.data);
      this._refreshPolicyState('server-policy-sync');
      return;
    }

    if (payload.type === 'active-tab-changed') {
      this._invalidateFrameBootstrap('active-tab-changed');
    }

    if (payload.type === 'tab-updated' || payload.type === 'tab-attached') {
      this._updateLegacyTabCache(payload.data);
    } else if (payload.type === 'tab-created') {
      this._addLegacyTabCache(payload.data);
    } else if (payload.type === 'tab-closed') {
      this._removeLegacyTabCache(payload.data);
    }

    this._emitBrowserBoxEvent(payload.type, payload.data || {});
  }

  _request(type, data = {}, options = {}) {
    if (!this.iframe.contentWindow) {
      const error = createBrowserBoxError('browserbox-webview iframe is not ready.', {
        code: ERROR_CODES.TRANSPORT,
        retriable: true,
        status: 503,
        requestType: type,
      });
      this._rememberError(error);
      return Promise.reject(error);
    }

    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(100, Math.round(options.timeoutMs))
      : this.requestTimeoutMs;

    const requestId = `bbx-${Date.now()}-${++this._requestSeq}`;
    const message = { type, requestId, data, ...(options.messageExtras || {}) };
    const targetOrigin = this._outboundTargetOrigin();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        const error = createBrowserBoxError(`browserbox-webview request timed out (${type}) after ${timeoutMs}ms.`, {
          code: ERROR_CODES.TIMEOUT,
          retriable: true,
          status: 504,
          requestId,
          requestType: type,
          timeoutMs,
        });
        this._rememberError(error);
        reject(error);
      }, timeoutMs);

      this._pending.set(requestId, { resolve, reject, timer });
      try {
        this.iframe.contentWindow.postMessage(message, targetOrigin);
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        const transportError = createBrowserBoxError(`browserbox-webview failed to postMessage '${type}'.`, {
          code: ERROR_CODES.TRANSPORT,
          retriable: true,
          status: 503,
          requestId,
          requestType: type,
          cause: error,
        });
        this._rememberError(transportError);
        reject(transportError);
      }
    });
  }

  _postRaw(message) {
    if (!this.iframe.contentWindow) {
      return;
    }
    this.iframe.contentWindow.postMessage(message, this._outboundTargetOrigin());
  }

  _forwardToParent(message) {
    if (window.parent === window) {
      return;
    }
    try {
      window.parent.postMessage(message, '*');
    } catch (error) {
      console.warn('[browserbox-webview] failed to forward message to parent', error);
    }
  }

  async whenReady({ timeoutMs = this.requestTimeoutMs } = {}) {
    if (this._isReady) {
      return true;
    }

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(createBrowserBoxError(`browserbox-webview ready timeout after ${timeoutMs}ms.`, {
        code: ERROR_CODES.TIMEOUT,
        retriable: true,
        status: 504,
        timeoutMs,
      })), timeoutMs);
    });

    await Promise.race([this._readyPromise, timeout]);
    return true;
  }

  on(eventName, handler, options) {
    this._assertCapability('events.read');
    if (typeof eventName !== 'string' || eventName.trim().length === 0) {
      throwInvalidArgument('browserbox-webview on(eventName, handler) requires a non-empty eventName.');
    }
    if (typeof handler !== 'function') {
      throwInvalidArgument('browserbox-webview on(eventName, handler) requires handler to be a function.');
    }
    this.addEventListener(eventName, handler, options);
    return () => {
      this.removeEventListener(eventName, handler, options);
    };
  }

  off(eventName, handler, options) {
    if (typeof eventName !== 'string' || eventName.trim().length === 0) {
      throwInvalidArgument('browserbox-webview off(eventName, handler) requires a non-empty eventName.');
    }
    if (typeof handler !== 'function') {
      throwInvalidArgument('browserbox-webview off(eventName, handler) requires handler to be a function.');
    }
    this.removeEventListener(eventName, handler, options);
  }

  async observe(config = {}) {
    this._assertCapability('events.read');
    const subscriptionEntries = [];
    const snapshot = (!config || typeof config !== 'object' || Array.isArray(config))
      ? {}
      : { ...config };
    const id = generateOpaqueId('bbx-observe');
    return {
      id,
      config: snapshot,
      on: (eventName, handler, options) => {
        const unsubscribe = this.on(eventName, handler, options);
        subscriptionEntries.push({ eventName, handler, options });
        return unsubscribe;
      },
      off: (eventName, handler, options) => {
        this.off(eventName, handler, options);
      },
      unsubscribe: () => {
        for (const entry of subscriptionEntries.splice(0, subscriptionEntries.length)) {
          this.removeEventListener(entry.eventName, entry.handler, entry.options);
        }
      },
    };
  }

  events(options = {}) {
    this._assertCapability('events.read');
    const eventNames = Array.isArray(options?.eventNames)
      ? new Set(options.eventNames.map((name) => String(name)))
      : null;
    const subscriber = {
      queue: [],
      resolve: null,
      closed: false,
      maxQueue: Number.isInteger(options?.maxQueue) ? Math.max(10, options.maxQueue) : 100,
      filter: eventNames ? ((event) => eventNames.has(event.type)) : (() => true),
    };
    this._eventSubscribers.add(subscriber);

    const cleanup = () => {
      subscriber.closed = true;
      this._eventSubscribers.delete(subscriber);
      if (subscriber.resolve) {
        const resolve = subscriber.resolve;
        subscriber.resolve = null;
        resolve({ value: undefined, done: true });
      }
    };

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (subscriber.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        const queued = subscriber.queue.shift();
        if (queued) {
          return Promise.resolve({ value: queued, done: false });
        }
        return new Promise((resolve) => {
          subscriber.resolve = resolve;
        });
      },
      return: () => {
        cleanup();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: async (error) => {
        cleanup();
        throw error;
      },
    };
  }

  async _ensureReadyForApi() {
    if (this._isReady) {
      return true;
    }
    const softTimeoutMs = Math.min(this.requestTimeoutMs, 8000);
    try {
      await this.whenReady({ timeoutMs: softTimeoutMs });
      return true;
    } catch (error) {
      this._rememberError(error);
      this.dispatchEvent(new CustomEvent('ready-timeout', {
        detail: {
          timeoutMs: softTimeoutMs,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
      return false;
    }
  }

  _legacyMethodList() {
    return [
      'getTabs',
      'getActiveTabIndex',
      'getTabCount',
      'createTab',
      'createTabs',
      'closeTab',
      'closeTabById',
      'closeAllTabs',
      'switchToTab',
      'switchToTabById',
      'navigateTo',
      'navigateTab',
      'submitOmnibox',
      'reload',
      'goBack',
      'goForward',
      'stop',
      'evaluate',
      'waitForTabCount',
      'waitForTabUrl',
    ];
  }

  /**
   * Resolve transport mode. Called once on first API call if transport is
   * still 'unknown'. After resolution, transport is locked for the session.
   * @returns {Promise<'modern'|'legacy'>}
   */
  async _resolveTransport() {
    if (this._transportMode !== 'unknown') return this._transportMode;
    try {
      await this._request('bbx-api-call', { method: 'getTabCount', args: [] }, {
        timeoutMs: Math.min(this.requestTimeoutMs, 5000),
      });
      this._transportMode = 'modern';
    } catch {
      this._transportMode = 'legacy';
    }
    return this._transportMode;
  }

  async listApiMethods(options = {}) {
    if (this._apiMethods.length > 0) {
      return this._apiMethods.slice();
    }
    const ready = await this._ensureReadyForApi();
    if (!ready) {
      throw createBrowserBoxError('browserbox-webview API handshake is not ready.', {
        code: ERROR_CODES.NOT_READY,
        retriable: true,
        status: 409,
      });
    }
    if (this._transportMode === 'legacy') {
      this._apiMethods = this._legacyMethodList();
      return this._apiMethods.slice();
    }
    try {
      const methods = await this._request('bbx-api-list', {}, {
        ...options,
        timeoutMs: Number.isFinite(options.timeoutMs)
          ? options.timeoutMs
          : Math.min(this.requestTimeoutMs, 5000),
      });
      this._apiMethods = Array.isArray(methods) ? methods.slice() : [];
      this._transportMode = 'modern';
    } catch {
      this._transportMode = 'legacy';
      this._apiMethods = this._legacyMethodList();
    }
    return this._apiMethods.slice();
  }

  /**
   * Call a BrowserBox API method by name.
   * @param {string} method - API method name (e.g. 'getTabs', 'createTab')
   * @param {...*} args - Method arguments
   * @returns {Promise<*>} Method result
   * @throws {Error} If method is empty, transport fails, or call times out
   */
  async callApi(method, ...args) {
    if (typeof method !== 'string' || method.trim().length === 0) {
      throwInvalidArgument('callApi(method, ...args) requires a non-empty method string.');
    }
    const invoke = async () => {
      const ready = await this._ensureReadyForApi();
      if (!ready) {
        throw createBrowserBoxError(`browserbox-webview API method '${method}' called before handshake completed.`, {
          code: ERROR_CODES.NOT_READY,
          retriable: true,
          status: 409,
          method,
        });
      }
      const normalizedMethod = method.trim();
      for (const capability of this._capabilitiesForMethod(normalizedMethod, args)) {
        this._assertCapability(capability);
      }

      if (this._transportMode === 'unknown') {
        await this._resolveTransport();
      }

      if (this._transportMode === 'legacy') {
        return this._legacyCall(normalizedMethod, args);
      }

      return this._request('bbx-api-call', { method: normalizedMethod, args }, {
        timeoutMs: this.requestTimeoutMs,
      });
    };

    try {
      const result = await this._withRetry(invoke, {
        attempts: 3,
        baseDelayMs: 300,
        maxDelayMs: 1500,
        shouldRetry: (error) => this._isRetryableApiError(error),
      });
      this._rememberError(null);
      this._setUsable(true, 'api-ok');
      return result;
    } catch (error) {
      this._rememberError(error);
      if (this._isRetryableApiError(error)) {
        this._setUsable(false, 'api-failed');
      }
      throw this._normalizeRemoteError(error, { method });
    }
  }

  async act(actionRequest) {
    if (!actionRequest || typeof actionRequest !== 'object' || Array.isArray(actionRequest)) {
      throwInvalidArgument('browserbox-webview act(action) requires an object action request.');
    }
    const actionNames = Object.keys(actionRequest).filter((key) => actionRequest[key] !== undefined);
    if (actionNames.length !== 1) {
      throwInvalidArgument('browserbox-webview act(action) requires exactly one action key.');
    }

    const actionName = actionNames[0];
    const payload = actionRequest[actionName];
    let value;

    switch (actionName) {
      case 'navigate':
        value = await this.page.navigate(assertNonEmptyString(payload, 'act({ navigate })'));
        return normalizeActionResult(actionName, value);
      case 'click': {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throwInvalidArgument('browserbox-webview act({ click }) requires an object payload.');
        }
        const { selector, ...clickOptions } = payload;
        value = await this.click(assertNonEmptyString(selector, 'act({ click: { selector } })'), clickOptions);
        return normalizeActionResult(actionName, value);
      }
      case 'type': {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throwInvalidArgument('browserbox-webview act({ type }) requires an object payload.');
        }
        const {
          selector,
          text,
          ...typeOptions
        } = payload;
        if (typeof text !== 'string') {
          throwInvalidArgument('browserbox-webview act({ type }) requires payload.text to be a string.');
        }
        value = await this.type(assertNonEmptyString(selector, 'act({ type: { selector } })'), text, typeOptions);
        return normalizeActionResult(actionName, value);
      }
      case 'evaluate':
        value = await this.evaluate(assertNonEmptyString(payload, 'act({ evaluate })'));
        return normalizeActionResult(actionName, value);
      case 'waitForNavigation':
        value = await this.waitForNavigation((payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {});
        return normalizeActionResult(actionName, value);
      case 'waitForSelector': {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throwInvalidArgument('browserbox-webview act({ waitForSelector }) requires an object payload.');
        }
        const { selector, ...waitOptions } = payload;
        value = await this.waitForSelector(
          assertNonEmptyString(selector, 'act({ waitForSelector: { selector } })'),
          waitOptions,
        );
        return normalizeActionResult(actionName, value);
      }
      default:
        throw createBrowserBoxError(`browserbox-webview act(action) does not support '${actionName}'.`, {
          code: ERROR_CODES.UNSUPPORTED,
          status: 501,
          action: actionName,
        });
    }
  }

  navigate(url, opts = {}) {
    return this.page.navigate(url, opts);
  }

  async capabilities() {
    return { ...this._capabilityMap };
  }

  /**
   * Ensure at least one tab exists, creating one if necessary.
   * Many operations (navigateTo, goBack, reload, …) silently fail when the
   * session has zero tabs.  Call this before any tab-dependent action.
   * @param {string} [url] - Optional URL to open if a tab must be created.
   * @returns {Promise<void>}
   */
  async _ensureTab(url) {
    try {
      const tabs = await this.callApi('getTabs');
      if (Array.isArray(tabs) && tabs.length > 0) return;
    } catch { /* treat failure as "no tabs" */ }
    await this.callApi('createTab', url || '');
  }

  // Canonical BrowserBox API wrappers
  switchToTab(index) { return this.callApi('switchToTab', index); }
  switchToTabById(targetId) { return this.callApi('switchToTabById', targetId); }
  async navigateTo(url, opts = {}) {
    await this._ensureTab(url);
    return this.callApi('navigateTo', url, opts);
  }
  navigateTab(index, url, opts = {}) { return this.callApi('navigateTab', index, url, opts); }
  submitOmnibox(query, opts = {}) { return this.callApi('submitOmnibox', query, opts); }
  createTab(url = '') { return this.callApi('createTab', url); }
  createTabs(count, opts = {}) { return this.callApi('createTabs', count, opts); }
  closeTab(index = null) { return this.callApi('closeTab', index); }
  closeTabById(targetId) { return this.callApi('closeTabById', targetId); }
  closeAllTabs(opts = {}) { return this.callApi('closeAllTabs', opts); }
  getTabs() { return this.callApi('getTabs'); }
  getFavicons() { return this.callApi('getFavicons'); }
  waitForNonDefaultFavicon(index, opts = {}) { return this.callApi('waitForNonDefaultFavicon', index, opts); }
  waitForTabCount(expectedCount, opts = {}) { return this.callApi('waitForTabCount', expectedCount, opts); }
  waitForTabUrl(index, opts = {}) { return this.callApi('waitForTabUrl', index, opts); }
  getActiveTabIndex() { return this.callApi('getActiveTabIndex'); }
  getTabCount() { return this.callApi('getTabCount'); }
  reload() { return this.callApi('reload'); }
  goBack() { return this.callApi('goBack'); }
  goForward() { return this.callApi('goForward'); }
  stop() { return this.callApi('stop'); }
  getScreenMetrics() { return this.callApi('getScreenMetrics'); }
  getTransportDiagnostics() { return this.callApi('getTransportDiagnostics'); }
  frameCapture(enabled = true) { return this.callApi('frameCapture', Boolean(enabled)); }
  getFrame() { return this.callApi('getFrame'); }
  cleanSlate(url) { return this.callApi('cleanSlate', url); }
  async health({ timeoutMs } = {}) {
    const startedAt = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const finalize = (ok, transport, error = null) => ({
      ok,
      usable: this._usable,
      ready: this._isReady,
      transport,
      sessionId: this.routingMid || null,
      timestamp: new Date().toISOString(),
      latencyMs: Math.max(
        0,
        Math.round(((typeof performance !== 'undefined' && typeof performance.now === 'function')
          ? performance.now()
          : Date.now()) - startedAt),
      ),
      diagnostics: {
        reconnecting: !this._isReady && !this._reconnectStopped,
        lastErrorCode: error?.code || this._lastError?.code,
        lastErrorMessage: error?.message || this._lastError?.message,
      },
    });
    if (!this.iframe.contentWindow) {
      this._setUsable(false, 'iframe-not-ready');
      const error = createBrowserBoxError('browserbox-webview health check failed: iframe is not ready.', {
        code: ERROR_CODES.TRANSPORT,
        retriable: true,
        status: 503,
      });
      this._rememberError(error);
      return finalize(false, this._transportMode, error);
    }
    const effectiveTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(100, Math.round(timeoutMs))
      : Math.min(this.requestTimeoutMs, 8000);
    const tryModern = () => this._request(
      'bbx-api-call',
      { method: 'getTabCount', args: [] },
      { timeoutMs: effectiveTimeoutMs },
    );
    const tryLegacy = () => this._request('getTabCount', {}, { timeoutMs: effectiveTimeoutMs });

    try {
      const result = await this._withRetry(async () => {
        if (this._transportMode === 'modern') {
          await tryModern();
          return true;
        }
        if (this._transportMode === 'legacy') {
          await tryLegacy();
          return true;
        }
        try {
          await tryModern();
          this._transportMode = 'modern';
          return true;
        } catch (modernError) {
          try {
            await tryLegacy();
            this._transportMode = 'legacy';
            return true;
          } catch (legacyError) {
            const message = `browserbox-webview health check failed after ${effectiveTimeoutMs}ms `
              + `(modern error: ${modernError instanceof Error ? modernError.message : String(modernError)}; `
              + `legacy error: ${legacyError instanceof Error ? legacyError.message : String(legacyError)})`;
            throw createBrowserBoxError(message, {
              code: ERROR_CODES.TRANSPORT,
              retriable: true,
              status: 503,
              cause: legacyError,
            });
          }
        }
      }, {
        attempts: 2,
        baseDelayMs: 250,
        maxDelayMs: 750,
        shouldRetry: (error) => this._isRetryableApiError(error),
      });
      this._rememberError(null);
      this._setUsable(true, 'health-ok');
      return finalize(Boolean(result), this._transportMode);
    } catch (error) {
      const normalizedError = this._normalizeRemoteError(error, { method: 'health' });
      this._rememberError(normalizedError);
      this._setUsable(false, 'health-failed');
      return finalize(false, this._transportMode, normalizedError);
    }
  }

  // UI visibility controls — update attribute (source of truth) + sync to iframe
  uiVisible(visible) {
    if (visible !== undefined) {
      this.setAttribute('ui-visible', String(Boolean(visible)));
    }
    return this.callApi('uiVisible', visible);
  }
  allowUserToggleUI(allow) {
    if (allow !== undefined) {
      this.setAttribute('allow-user-toggle-ui', String(Boolean(allow)));
    }
    return this.callApi('allowUserToggleUI', allow);
  }

  // Automation surface
  waitForSelector(selector, opts = {}) { return this.callApi('waitForSelector', selector, opts); }
  click(selector, opts = {}) { return this.callApi('click', selector, opts); }
  type(selector, text, opts = {}) { return this.callApi('type', selector, text, opts); }
  evaluate(expression, opts = {}) { return this.callApi('evaluate', expression, opts); }
  waitForNavigation(opts = {}) { return this.callApi('waitForNavigation', opts); }

  refresh() {
    if (this.iframe.src) {
      this._isReady = false;
      this._apiMethods = [];
      this._transportMode = 'unknown';
      this._legacyTabsCache = [];
      this._reconnectStopped = false;
      this._midSyncAcked = false;
      this._resetReadyPromise();
      this._rejectPending(createBrowserBoxError('browserbox-webview refreshed.', {
        code: ERROR_CODES.TRANSPORT,
        retriable: true,
        status: 503,
      }));
      const currentSrc = this.iframe.src;
      this._assignIframeSrc(currentSrc, 'refresh');
    }
  }

  async disconnect() {
    this.stopReconnectAttempts('session.disconnect');
    this._isReady = false;
    this._apiMethods = [];
    this._transportMode = 'unknown';
    this._legacyTabsCache = [];
    this._resetReadyPromise();
    if (this.iframe.src) {
      this.iframe.removeAttribute('src');
    }
    this._emitBrowserBoxEvent('disconnected', {
      reason: 'session.disconnect',
    });
    return true;
  }

  stopReconnectAttempts(reason = 'manual-stop') {
    this._reconnectStopped = true;
    this._stopInitPing();
    this._stopMidSync();
    this._setUsable(false, reason);
    this._rejectPending(createBrowserBoxError(`browserbox-webview reconnect stopped (${reason}).`, {
      code: ERROR_CODES.TRANSPORT,
      retriable: true,
      status: 503,
      reason,
    }));
  }

  /**
   * Public API: host window managers call this when the webview's container
   * becomes visible again (e.g. desktop window restored from minimize).
   * Bypasses poll-timer latency and forces immediate frame reactivation.
   */
  requestFrameRefresh(reason = 'host-request') {
    this._lastEffectiveVisibility = false;
    this._scheduleVisibilityWake(reason);
  }

  /**
   * Direct "re-click the active tab" — calls switchToTabById without
   * visibility or dimension checks.  Use this from host UI actions
   * (taskbar restore, window un-minimize) where we KNOW the element is
   * about to be visible but layout may not have settled yet.
   * Falls back to the full bootstrap chain if the quick path fails.
   */
  async reactivateActiveTab(reason = 'host-reactivate') {
    try {
      const ready = await this._ensureReadyForApi();
      if (!ready) {
        this.requestFrameRefresh(reason);
        return false;
      }
      const activeTab = await this._getActiveTabInfo(null).catch(() => null);
      const tabId = activeTab?.id || activeTab?.targetId || null;
      if (!tabId) {
        this.requestFrameRefresh(reason);
        return false;
      }
      if (this._transportMode === 'legacy') {
        await this._legacyCall('switchToTabById', [tabId]);
      } else {
        await this._request('bbx-api-call', {
          method: 'switchToTabById',
          args: [tabId],
        }, {
          timeoutMs: Math.min(this.requestTimeoutMs, 5000),
        });
      }
      console.info('[browserbox-webview] reactivateActiveTab succeeded', { reason, tabId });
      return true;
    } catch (error) {
      console.warn('[browserbox-webview] reactivateActiveTab failed, falling back', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      this.requestFrameRefresh(reason);
      return false;
    }
  }

  updateIframe() {
    this._refreshRoutingMid();
    this._updateIframeSrcFromAttribute('updateIframe');
    this._applyHostDimensions();
    this._sendUISync('updateIframe');
  }

  get loginLink() {
    return this.getAttribute('login-link');
  }

  set loginLink(value) {
    if (value) this.setAttribute('login-link', value);
    else this.removeAttribute('login-link');
  }

  get routingMid() {
    return this._routingMid || '';
  }

  get width() {
    return this.getAttribute('width');
  }

  set width(value) {
    if (value) this.setAttribute('width', value);
    else this.removeAttribute('width');
  }

  get height() {
    return this.getAttribute('height');
  }

  set height(value) {
    if (value) this.setAttribute('height', value);
    else this.removeAttribute('height');
  }

  get embedderOrigin() {
    return this.getAttribute('embedder-origin')
      || this.getAttribute('parent-origin')
      || '*';
  }

  set embedderOrigin(value) {
    if (value) this.setAttribute('embedder-origin', value);
    else this.removeAttribute('embedder-origin');
  }

  /** @deprecated Use embedderOrigin instead. */
  get parentOrigin() {
    return this.embedderOrigin;
  }

  /** @deprecated Use embedderOrigin instead. */
  set parentOrigin(value) {
    this.embedderOrigin = value;
  }

  get requestTimeoutMs() {
    const raw = this.getAttribute('request-timeout-ms');
    const parsed = Number.parseInt(raw || '30000', 10);
    if (!Number.isFinite(parsed) || parsed < 100) {
      return 30000;
    }
    return parsed;
  }

  set requestTimeoutMs(value) {
    if (value === null || value === undefined) {
      this.removeAttribute('request-timeout-ms');
      return;
    }
    this.setAttribute('request-timeout-ms', String(value));
  }

  /**
   * Legacy transport dispatch. Each handler is a small function in a lookup
   * table — avoids the 180-line if/else chain (Architecture §6, §3).
   * @param {string} method
   * @param {Array} args
   * @param {Error|null} originalError
   * @returns {Promise<*>}
   */
  async _legacyCall(method, args = [], originalError = null) {
    const handler = this._legacyHandlers[method];
    if (!handler) {
      const detail = originalError?.message ? ` (${originalError.message})` : '';
      throw createBrowserBoxError(`No legacy fallback for API method '${method}'${detail}`, {
        code: ERROR_CODES.UNSUPPORTED,
        status: 501,
        method,
        ...(originalError ? { cause: originalError } : {}),
      });
    }
    return handler.call(this, args, originalError);
  }

  get _legacyHandlers() {
    if (this.__legacyHandlers) return this.__legacyHandlers;
    const self = this;

    const fail = (message, originalError = null) => {
      const detail = originalError?.message ? ` (${originalError.message})` : '';
      throw self._normalizeRemoteError(
        createBrowserBoxError(`${message}${detail}`, {
          code: ERROR_CODES.INTERNAL,
          status: 500,
          ...(originalError ? { cause: originalError } : {}),
        }),
      );
    };

    const resolveTabId = async (indexArg = null) => {
      if (typeof indexArg === 'string' && indexArg.trim().length > 0) return indexArg.trim();
      const tabs = await self._legacyHandlers.getTabs.call(self, []);
      if (Array.isArray(tabs) && tabs.length > 0) {
        const requested = Number.isInteger(indexArg) ? indexArg : 0;
        const normalized = requested < 0 ? tabs.length + requested : requested;
        const safeIndex = Math.max(0, Math.min(tabs.length - 1, normalized));
        return tabs[safeIndex]?.id || tabs[safeIndex]?.targetId || null;
      }
      const activeTab = await self._request('getActiveTab', {}).catch(() => null);
      return activeTab?.id || activeTab?.targetId || null;
    };

    this.__legacyHandlers = {
      async getTabs() {
        let tabs;
        try {
          tabs = await self._request('getTabs', {});
        } catch {
          tabs = self._legacyTabsCache.slice();
        }
        if (!Array.isArray(tabs)) return self._legacyTabsCache.slice();
        const normalizedTabs = tabs.map((tab, index) => ({ index, ...tab }));
        self._legacyTabsCache = normalizedTabs.slice();
        return normalizedTabs;
      },

      async getActiveTabIndex() {
        const [tabs, activeTab] = await Promise.all([
          self._legacyHandlers.getTabs.call(self, []),
          self._request('getActiveTab', {}).catch(() => null),
        ]);
        if (!activeTab || !Array.isArray(tabs)) return -1;
        const activeId = activeTab.id || activeTab.targetId || null;
        return tabs.findIndex((tab) => (tab.id || tab.targetId) === activeId);
      },

      async getTabCount() {
        const tabs = await self._legacyHandlers.getTabs.call(self, []);
        return Array.isArray(tabs) ? tabs.length : 0;
      },

      async createTab(args) {
        const url = typeof args[0] === 'string' ? args[0] : '';
        self._postRaw({ type: 'createTab', data: { url } });
        return true;
      },

      async createTabs(args) {
        const count = Number.isInteger(args[0]) && args[0] > 0 ? args[0] : 0;
        const opts = args[1] || {};
        const url = typeof opts.url === 'string' ? opts.url : '';
        for (let i = 0; i < count; i += 1) {
          self._postRaw({ type: 'createTab', data: { url } });
        }
        return true;
      },

      async closeTab(args, originalError) {
        const tabId = await resolveTabId(args[0]);
        if (!tabId) fail('Legacy closeTab failed: no target tab', originalError);
        self._postRaw({ type: 'closeTab', tabId, data: {} });
        return true;
      },

      async closeTabById(args, originalError) {
        const tabId = typeof args[0] === 'string' && args[0].trim().length > 0 ? args[0].trim() : null;
        if (!tabId) fail('Legacy closeTabById requires a non-empty targetId string', originalError);
        self._postRaw({ type: 'closeTab', tabId, data: {} });
        return true;
      },

      async closeAllTabs(args) {
        const opts = args[0] || {};
        const keep = Number.isInteger(opts.keep) ? Math.max(0, opts.keep) : 0;
        const tabs = await self._legacyHandlers.getTabs.call(self, []);
        if (!Array.isArray(tabs) || tabs.length <= keep) return tabs?.length || 0;
        for (let i = tabs.length - 1; i >= keep; i -= 1) {
          const tabId = tabs[i]?.id || tabs[i]?.targetId;
          if (!tabId) continue;
          self._postRaw({ type: 'closeTab', tabId, data: {} });
        }
        return Math.max(keep, 0);
      },

      async switchToTab(args, originalError) {
        const tabId = await resolveTabId(args[0]);
        if (!tabId) fail('Legacy switchToTab failed: no target tab', originalError);
        self._postRaw({ type: 'setActiveTab', tabId, data: {} });
        return true;
      },

      async switchToTabById(args, originalError) {
        const tabId = typeof args[0] === 'string' && args[0].trim().length > 0 ? args[0].trim() : null;
        if (!tabId) fail('Legacy switchToTabById requires a non-empty targetId string', originalError);
        self._postRaw({ type: 'setActiveTab', tabId, data: {} });
        return true;
      },

      async navigateTo(args, originalError) {
        const url = typeof args[0] === 'string' ? args[0] : '';
        const tabId = await resolveTabId(null);
        if (!tabId) fail('Legacy navigateTo failed: no active tab', originalError);
        self._postRaw({ type: 'loadURL', tabId, data: { url } });
        return true;
      },

      async navigateTab(args, originalError) {
        const tabId = await resolveTabId(args[0]);
        const url = typeof args[1] === 'string' ? args[1] : '';
        if (!tabId) fail('Legacy navigateTab failed: no target tab', originalError);
        self._postRaw({ type: 'setActiveTab', tabId, data: {} });
        self._postRaw({ type: 'loadURL', tabId, data: { url } });
        return true;
      },

      async submitOmnibox(args, originalError) {
        const query = typeof args[0] === 'string' ? args[0] : '';
        return self._legacyHandlers.navigateTo.call(self, [query], originalError);
      },

      async reload(args, originalError) {
        const tabId = await resolveTabId(null);
        if (!tabId) fail('Legacy reload failed: no active tab', originalError);
        self._postRaw({ type: 'reload', tabId, data: {} });
        return true;
      },

      async goBack(args, originalError) {
        const tabId = await resolveTabId(null);
        if (!tabId) fail('Legacy goBack failed: no active tab', originalError);
        self._postRaw({ type: 'goBack', tabId, data: {} });
        return true;
      },

      async goForward(args, originalError) {
        const tabId = await resolveTabId(null);
        if (!tabId) fail('Legacy goForward failed: no active tab', originalError);
        self._postRaw({ type: 'goForward', tabId, data: {} });
        return true;
      },

      async stop(args, originalError) {
        const tabId = await resolveTabId(null);
        if (!tabId) fail('Legacy stop failed: no active tab', originalError);
        self._postRaw({ type: 'stop', tabId, data: {} });
        return true;
      },

      async evaluate(args, originalError) {
        const expression = typeof args[0] === 'string' ? args[0] : '';
        const tabId = await resolveTabId(null);
        if (!tabId) fail('Legacy evaluate failed: no active tab', originalError);
        if (expression.includes('history.back')) {
          self._postRaw({ type: 'goBack', tabId, data: {} });
          return true;
        }
        if (expression.includes('history.forward')) {
          self._postRaw({ type: 'goForward', tabId, data: {} });
          return true;
        }
        if (expression.includes('window.stop')) {
          self._postRaw({ type: 'stop', tabId, data: {} });
          return true;
        }
        fail('Legacy evaluate only supports history.back, history.forward, and window.stop', originalError);
      },

      async waitForTabCount(args, originalError) {
        const expectedCount = Number.isInteger(args[0]) ? args[0] : 0;
        const opts = args[1] || {};
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : self.requestTimeoutMs;
        const pollMs = Number.isFinite(opts.pollMs) ? Math.max(50, opts.pollMs) : 150;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const tabs = await self._legacyHandlers.getTabs.call(self, []);
          if (tabs.length === expectedCount) return tabs.length;
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        fail(`Legacy waitForTabCount timed out waiting for ${expectedCount}`, originalError);
      },

      async waitForTabUrl(args, originalError) {
        const tabIndex = Number.isInteger(args[0]) ? args[0] : 0;
        const opts = args[1] || {};
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : self.requestTimeoutMs;
        const pollMs = Number.isFinite(opts.pollMs) ? Math.max(50, opts.pollMs) : 150;
        const expectIncludes = typeof opts.expectIncludes === 'string' ? opts.expectIncludes : '';
        const allowBlank = Boolean(opts.allowBlank);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const tabs = await self._legacyHandlers.getTabs.call(self, []);
          if (Array.isArray(tabs) && tabs.length > 0) {
            const safeIndex = Math.max(0, Math.min(tabs.length - 1, tabIndex));
            const url = tabs[safeIndex]?.url || '';
            if (allowBlank || url) {
              if (!expectIncludes || url.includes(expectIncludes)) {
                return { index: safeIndex, id: tabs[safeIndex]?.id || tabs[safeIndex]?.targetId, url };
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        fail(`Legacy waitForTabUrl timed out for tab ${tabIndex}`, originalError);
      },
    };

    return this.__legacyHandlers;
  }

}

if (!customElements.get('browserbox-webview')) {
  customElements.define('browserbox-webview', BrowserBoxWebview);
}
