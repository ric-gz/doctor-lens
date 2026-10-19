import fs from "node:fs";
import path from "node:path";
import type { DiscoveredAssets } from "./types.js";

/**
 * Bundled DICOM viewer and utility folders present in Siemens/Weasis/MicroDicom CD exports
 * that must be ignored during scanning.
 */
const IGNORED_DIRECTORIES = new Set([
  "weasis",
  "win32",
  "x64",
  "viewer-mac.app",
  "licenses",
  "settings",
]);

/**
 * Non-medical file extensions and index filenames to ignore.
 */
const IGNORED_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".bat",
  ".sh",
  ".ini",
  ".jar",
  ".gz",
  ".xz",
  ".txt",
  ".xml",
  ".chm",
  ".lic",
  ".plist",
  ".icns",
  ".rsrc",
  ".rtf",
  ".scpt",
  ".properties",
  ".sample",
  ".inf",
  ".md",
  ".json",
]);

const STANDARD_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
]);

/**
 * Checks whether a file has the standard DICOM Part 10 `"DICM"` magic bytes at offset 128..132.
 */
export function isDicomPart10File(filePath: string): boolean {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 132) {
      return false;
    }
    fd = fs.openSync(filePath, "r");
    const magicBuf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, magicBuf, 0, 4, 128);
    if (bytesRead !== 4) {
      return false;
    }
    return magicBuf.toString("ascii") === "DICM";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

function walkDirectory(
  dirPath: string,
  onFile: (filePath: string, fileName: string, ext: string) => void
): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        continue;
      }
      walkDirectory(fullPath, onFile);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      onFile(fullPath, entry.name, ext);
    }
  }
}

/**
 * Scans `data/<body-part-id>` for `mri/` and `x-ray/` subdirectories and discovers
 * all raw DICOM files and standard X-Ray images.
 */
export function scanCaseAssets(caseDataDir: string): DiscoveredAssets {
  const mriDir = path.join(caseDataDir, "mri");
  const xrayDir = path.join(caseDataDir, "x-ray");

  const hasMri = fs.existsSync(mriDir) && fs.statSync(mriDir).isDirectory();
  const hasXray = fs.existsSync(xrayDir) && fs.statSync(xrayDir).isDirectory();

  if (!hasMri && !hasXray) {
    throw new Error(
      `Neither 'mri/' nor 'x-ray/' folder was found inside ${caseDataDir}. At least one modality folder must be present.`
    );
  }

  const mriDicomFiles: string[] = [];
  const xrayImageFiles: string[] = [];
  const xrayDicomFiles: string[] = [];

  if (hasMri) {
    walkDirectory(mriDir, (filePath, fileName, ext) => {
      if (fileName.toUpperCase() === "DICOMDIR") {
        return;
      }
      if (IGNORED_EXTENSIONS.has(ext) || STANDARD_IMAGE_EXTENSIONS.has(ext)) {
        return;
      }
      if (isDicomPart10File(filePath)) {
        mriDicomFiles.push(filePath);
      }
    });
  }

  if (hasXray) {
    walkDirectory(xrayDir, (filePath, fileName, ext) => {
      if (fileName.toUpperCase() === "DICOMDIR") {
        return;
      }
      if (STANDARD_IMAGE_EXTENSIONS.has(ext)) {
        xrayImageFiles.push(filePath);
        return;
      }
      if (IGNORED_EXTENSIONS.has(ext)) {
        return;
      }
      if (isDicomPart10File(filePath)) {
        xrayDicomFiles.push(filePath);
      }
    });
  }

  if (
    mriDicomFiles.length === 0 &&
    xrayImageFiles.length === 0 &&
    xrayDicomFiles.length === 0
  ) {
    throw new Error(
      `No valid MRI DICOM slices or X-Ray images were found in ${caseDataDir}.`
    );
  }

  return {
    hasMri,
    hasXray,
    mriDicomFiles,
    xrayImageFiles,
    xrayDicomFiles,
  };
}
