const { readdirSync, rmSync, statSync } = require("fs");
const { join, relative, resolve } = require("path");

const CLOUDFLARE_PAGES_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const OUT_DIRECTORY = resolve(__dirname, "..", "out");
const OVERSIZED_DEMO_EXCLUSIONS = [
  ["Program Files", "BoxedWine", "fullWine1.7.55-v8.zip"],
  ["Program Files", "Quake3", "Quake3Game.pk3"],
  ["System", "ffmpeg", "ffmpeg-core.wasm"],
];

const walkFiles = (directoryPath) =>
  readdirSync(directoryPath, { withFileTypes: true }).flatMap((directoryEntry) => {
    const entryPath = join(directoryPath, directoryEntry.name);

    return directoryEntry.isDirectory() ? walkFiles(entryPath) : [entryPath];
  });

for (const pathSegments of OVERSIZED_DEMO_EXCLUSIONS) {
  const absolutePath = join(OUT_DIRECTORY, ...pathSegments);
  const displayPath = relative(resolve(__dirname, ".."), absolutePath);

  try {
    const fileSizeBytes = statSync(absolutePath).size;

    rmSync(absolutePath);
    console.info(
      `[cf-pages] removed ${displayPath} (${(fileSizeBytes / 1024 / 1024).toFixed(1)} MiB)`
    );
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      console.info(`[cf-pages] skipped missing ${displayPath}`);
      continue;
    }

    throw error;
  }
}

const remainingOversizedFiles = walkFiles(OUT_DIRECTORY)
  .map((filePath) => ({
    filePath,
    size: statSync(filePath).size,
  }))
  .filter(({ size }) => size > CLOUDFLARE_PAGES_MAX_FILE_SIZE_BYTES)
  .map(
    ({ filePath, size }) =>
      `${relative(resolve(__dirname, ".."), filePath)} (${(size / 1024 / 1024).toFixed(1)} MiB)`
  );

if (remainingOversizedFiles.length > 0) {
  throw new Error(
    `[cf-pages] remaining oversized assets:\n${remainingOversizedFiles.join("\n")}`
  );
}

console.info("[cf-pages] all exported assets are within Cloudflare Pages limits");
