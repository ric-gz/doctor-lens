import fs from "node:fs";
import path from "node:path";
import type { TransformationManifest } from "./types.js";

const MANIFEST_FILENAME = "manifest.json";

/**
 * Checks if valid transformed assets and `manifest.json` already exist in `reports/<body-part-id>/montages/`.
 * Returns the parsed `TransformationManifest` if all referenced image files exist and are non-empty,
 * or `null` if transformation needs to run.
 */
export function loadValidCache(
  montagesDir: string,
  expectedBodyPartId: string
): TransformationManifest | null {
  const manifestPath = path.join(montagesDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw) as TransformationManifest;

    if (
      !manifest ||
      manifest.version !== 3 ||
      manifest.bodyPartId !== expectedBodyPartId ||
      (!Array.isArray(manifest.mriSeries) && !Array.isArray(manifest.xrayImages))
    ) {
      return null;
    }

    const totalAssets =
      (manifest.mriSeries?.length ?? 0) + (manifest.xrayImages?.length ?? 0);
    if (totalAssets === 0) {
      return null;
    }

    // Verify all MRI montage PNG files and high-resolution panel files exist and have size > 0
    for (const series of manifest.mriSeries ?? []) {
      const filePath = path.join(montagesDir, series.montageFile);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        return null;
      }
      if (!Array.isArray(series.panelFiles) || series.panelFiles.length === 0) {
        return null;
      }
      for (const panelFile of series.panelFiles) {
        const panelPath = path.join(montagesDir, panelFile);
        if (!fs.existsSync(panelPath) || fs.statSync(panelPath).size === 0) {
          return null;
        }
      }
    }

    // Verify all co-registered paired MRI panel files exist and have size > 0
    for (const paired of manifest.pairedMriSeries ?? []) {
      for (const panelFile of paired.panelFiles ?? []) {
        const panelPath = path.join(montagesDir, panelFile);
        if (!fs.existsSync(panelPath) || fs.statSync(panelPath).size === 0) {
          return null;
        }
      }
    }

    // Verify all X-Ray image files exist and have size > 0
    for (const xray of manifest.xrayImages ?? []) {
      const filePath = path.join(montagesDir, xray.file);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        return null;
      }
    }

    return manifest;
  } catch {
    return null;
  }
}

/**
 * Saves the transformation manifest (`manifest.json`) inside `reports/<body-part-id>/montages/`.
 */
export function saveCacheManifest(
  montagesDir: string,
  manifest: TransformationManifest
): string {
  fs.mkdirSync(montagesDir, { recursive: true });
  const manifestPath = path.join(montagesDir, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  return manifestPath;
}
