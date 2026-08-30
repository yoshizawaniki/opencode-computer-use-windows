import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { getActivePage, artifactPath } from "../browser-session.js";

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function readPng(filePath) {
  return PNG.sync.read(readFileSync(filePath));
}

// Shared by screenshot_diff and wait_for_visual_change so the pixel-compare
// logic exists in exactly one place.
function diffPngs(beforePath, afterPath, threshold, diffImagePath, changeThreshold) {
  const before = readPng(beforePath);
  const after = readPng(afterPath);
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(
      `image size mismatch: ${beforePath} is ${before.width}x${before.height}, ` +
        `${afterPath} is ${after.width}x${after.height}`
    );
  }
  const { width, height } = before;
  const diff = new PNG({ width, height });
  const diffPixelCount = pixelmatch(before.data, after.data, diff.data, width, height, { threshold });
  writeFileSync(diffImagePath, PNG.sync.write(diff));
  const totalPixels = width * height;
  const diffRatio = diffPixelCount / totalPixels;
  // ponytail: a single area-ratio threshold over the WHOLE image. A small
  // real change (one button's label) on a full-page screenshot can be well
  // under 1% of total pixels even though it's clearly a change — observed
  // in practice at diffRatio=0.002 for a real button-text change. Default
  // is set low (0.1%) accordingly; callers comparing small crops/regions
  // should raise changeThreshold to avoid noise false-positives. Upgrade
  // path if this isn't good enough: bounding-box-of-changed-pixels instead
  // of a flat ratio.
  return { diffPixelCount, totalPixels, diffRatio, changed: diffRatio > changeThreshold, diffImagePath };
}

export function registerVisualTools(server) {
  server.registerTool(
    "browser_screenshot_region",
    {
      title: "Screenshot a region of the page",
      description:
        "Saves a PNG screenshot of the given pixel region (x, y, width, height) of the active tab " +
        "to the artifacts directory and returns its path.",
      inputSchema: {
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      },
    },
    async ({ x, y, width, height }) => {
      const page = await getActivePage();
      const file = artifactPath(`region-${Date.now()}.png`);
      await page.screenshot({ path: file, clip: { x, y, width, height } });
      return text(file);
    }
  );

  server.registerTool(
    "browser_screenshot_diff",
    {
      title: "Diff two screenshots",
      description:
        "Compares two PNG files pixel-by-pixel using pixelmatch, saves a diff image under " +
        "artifacts/screenshots, and returns diffPixelCount/totalPixels/diffRatio/changed/diffImagePath. " +
        "Throws if the two images differ in size.",
      inputSchema: {
        beforePath: z.string(),
        afterPath: z.string(),
        threshold: z.number().default(0.1).describe("pixelmatch per-pixel color-match sensitivity, 0-1"),
        changeThreshold: z
          .number()
          .default(0.001)
          .describe("fraction of total pixels that must differ to report changed:true (default 0.1%)"),
      },
    },
    async ({ beforePath, afterPath, threshold, changeThreshold }) => {
      const diffImagePath = artifactPath(`diff-${Date.now()}.png`);
      return text(diffPngs(beforePath, afterPath, threshold, diffImagePath, changeThreshold));
    }
  );

  server.registerTool(
    "browser_wait_for_visual_change",
    {
      title: "Wait for a region to change visually",
      description:
        "Polls a screenshot of the given region (or the full page if x/y/width/height are omitted) " +
        "every 300ms and compares it against the first captured frame. Returns as soon as the diff " +
        "ratio exceeds changeThreshold (default 0.1%), or {changed: false} if timeoutMs elapses with " +
        "no change (this is a normal result, not an error).",
      inputSchema: {
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        timeoutMs: z.number().default(5000),
        changeThreshold: z.number().default(0.001).describe("fraction of total pixels that must differ (default 0.1%)"),
      },
    },
    async ({ x, y, width, height, timeoutMs, changeThreshold }) => {
      const page = await getActivePage();
      const clip = x !== undefined && y !== undefined && width !== undefined && height !== undefined
        ? { x, y, width, height }
        : undefined;
      const pollMs = 300;
      const deadline = Date.now() + timeoutMs;

      const basePath = artifactPath(`watch-base-${Date.now()}.png`);
      await page.screenshot({ path: basePath, clip });

      while (Date.now() < deadline) {
        await page.waitForTimeout(Math.min(pollMs, Math.max(0, deadline - Date.now())));
        const framePath = artifactPath(`watch-frame-${Date.now()}.png`);
        await page.screenshot({ path: framePath, clip });
        const diffImagePath = artifactPath(`watch-diff-${Date.now()}.png`);
        const result = diffPngs(basePath, framePath, 0.1, diffImagePath, changeThreshold);
        if (result.changed) return text({ changed: true, ...result });
      }
      return text({ changed: false });
    }
  );
}
