#!/usr/bin/env node

/**
 * Post-build script: prepares the static export for serving under a subpath.
 *
 * How it works:
 *   1. Rewrites /_next/ references in HTML so initial <script>/<link> tags load correctly.
 *   2. Generates a service worker (sw.js) that intercepts ALL runtime fetches from the app
 *      and prepends the subpath prefix to absolute same-origin paths.
 *      This covers the 170+ hardcoded paths (/Program Files/, /System/, /Users/, etc.)
 *      without modifying the application source.
 *   3. Injects SW registration into the HTML. On first visit the SW installs and triggers
 *      a single reload so it can control all subsequent requests.
 *
 * Usage:
 *   node scripts/buildForSubpath.mjs [subpath] [destination]
 *
 * Examples:
 *   node scripts/buildForSubpath.mjs /demos/daedalos
 *   node scripts/buildForSubpath.mjs /demos/daedalos ../BrowserBox-source/perfect-saas/desktop/demos/daedalos
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "out");
const SUBPATH = (process.argv[2] || "/demos/daedalos").replace(/\/$/, "");
const DEST_DIR = process.argv[3];

if (!existsSync(OUT_DIR)) {
  console.error('Error: out/ directory not found. Run "yarn build" first.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Service Worker
// ---------------------------------------------------------------------------

const swContent = `/* Daedalos subpath rewriter — maps absolute paths to ${SUBPATH}/ */
const PREFIX = ${JSON.stringify(SUBPATH)};

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only touch same-origin requests
  if (url.origin !== location.origin) return;

  // Already has our prefix — pass through unchanged
  if (url.pathname === PREFIX || url.pathname.startsWith(PREFIX + "/")) return;

  // Prepend the subpath
  const target = new URL(PREFIX + url.pathname + url.search, url.origin);
  event.respondWith(fetch(new Request(target, event.request)));
});
`;

writeFileSync(join(OUT_DIR, "sw.js"), swContent);
console.log("  Created sw.js");

// ---------------------------------------------------------------------------
// 2. SW registration snippet (injected before </head>)
// ---------------------------------------------------------------------------

const swReg = [
  "<script>",
  'if("serviceWorker" in navigator){',
  `navigator.serviceWorker.register(${JSON.stringify(SUBPATH + "/sw.js")},`,
  `{scope:${JSON.stringify(SUBPATH + "/")}})`,
  ".then(function(r){",
  "if(navigator.serviceWorker.controller)return;",
  "var sw=r.installing||r.waiting;if(!sw)return;",
  'sw.addEventListener("statechange",function(){',
  'if(sw.state==="activated")location.reload()});',
  "});}",
  "</script>",
].join("");

// ---------------------------------------------------------------------------
// 3. Rewrite HTML files
// ---------------------------------------------------------------------------

function findFiles(dir, ext) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findFiles(full, ext));
    else if (entry.name.endsWith(ext)) results.push(full);
  }
  return results;
}

const htmlFiles = findFiles(OUT_DIR, ".html");
let count = 0;

for (const file of htmlFiles) {
  let html = readFileSync(file, "utf-8");
  const orig = html;

  // Rewrite /_next/ asset references so initial HTML loads work
  html = html.replaceAll("/_next/", `${SUBPATH}/_next/`);

  // Inject SW registration
  if (html.includes("</head>")) {
    html = html.replace("</head>", `${swReg}</head>`);
  }

  if (html !== orig) {
    writeFileSync(file, html);
    count++;
  }
}

console.log(`  Rewrote ${count} HTML file(s)`);

// ---------------------------------------------------------------------------
// 4. Copy to destination (optional)
// ---------------------------------------------------------------------------

if (DEST_DIR) {
  mkdirSync(DEST_DIR, { recursive: true });
  cpSync(OUT_DIR, DEST_DIR, { recursive: true });
  console.log(`  Copied output → ${DEST_DIR}`);
}

console.log(`\n✓ Ready to serve at ${SUBPATH}/`);
