import fs from "node:fs";
import dicomParser from "dicom-parser";
import type { CropBox, DicomSlice, MriSeriesGroup } from "./types.js";

/**
 * Safely reads a trimmed ASCII/Latin1 string from a DICOM dataset tag.
 * NOTE: Patient-identifying tags (group 0010) and institution/physician tags
 * are strictly excluded by design (NFR-1 Privacy by Design).
 */
function readCleanString(
  dataSet: dicomParser.DataSet,
  tag: string,
  defaultValue = ""
): string {
  try {
    const val = dataSet.string(tag);
    if (!val) return defaultValue;
    return val.replace(/\0/g, "").trim() || defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Parses a DICOM Decimal String (DS) tag which may contain multiple backslash-separated values
 * (e.g., "511\\600") and returns the first numeric value.
 */
function readFirstFloat(
  dataSet: dicomParser.DataSet,
  tag: string
): number | undefined {
  const str = readCleanString(dataSet, tag);
  if (!str) return undefined;
  const firstPart = str.split("\\")[0];
  const parsed = Number.parseFloat(firstPart);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parses a multi-valued DICOM Decimal String (DS) tag into an array of finite numbers.
 */
function readFloatArray(
  dataSet: dicomParser.DataSet,
  tag: string,
  expectedLength: number
): number[] | undefined {
  const str = readCleanString(dataSet, tag);
  if (!str) return undefined;
  const parts = str.split("\\").map((p) => Number.parseFloat(p.trim()));
  if (parts.length < expectedLength || parts.some((n) => !Number.isFinite(n))) {
    return undefined;
  }
  return parts.slice(0, expectedLength);
}

/**
 * Parses a DICOM Integer String (IS) tag into an integer.
 */
function readIntString(
  dataSet: dicomParser.DataSet,
  tag: string,
  defaultValue = 0
): number {
  const str = readCleanString(dataSet, tag);
  if (!str) return defaultValue;
  const parsed = Number.parseInt(str.split("\\")[0], 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Extracts raw rescaled pixel values as Float32Array before 8-bit windowing.
 */
function extractRescaledPixels(
  dataSet: dicomParser.DataSet,
  rows: number,
  cols: number,
  bitsAllocated: number,
  pixelRepresentation: number,
  rescaleSlope = 1,
  rescaleIntercept = 0
): Float32Array | null {
  const pixelElement = dataSet.elements.x7fe00010;
  if (!pixelElement || pixelElement.length === 0) {
    return null;
  }

  const numPixels = rows * cols;
  if (numPixels <= 0) {
    return null;
  }

  const byteOffset = dataSet.byteArray.byteOffset + pixelElement.dataOffset;
  const byteLength = pixelElement.length;
  const rawBuffer = dataSet.byteArray.buffer;

  const rescaled = new Float32Array(numPixels);

  if (bitsAllocated === 8) {
    if (byteLength < numPixels) return null;
    const src = new Uint8Array(rawBuffer, byteOffset, numPixels);
    for (let i = 0; i < numPixels; i++) {
      rescaled[i] = src[i] * rescaleSlope + rescaleIntercept;
    }
  } else if (bitsAllocated === 16) {
    if (byteLength < numPixels * 2) return null;
    const alignedBuf =
      byteOffset % 2 === 0
        ? rawBuffer.slice(byteOffset, byteOffset + numPixels * 2)
        : Uint8Array.prototype.slice.call(
            new Uint8Array(rawBuffer, byteOffset, numPixels * 2)
          ).buffer;

    const src =
      pixelRepresentation === 1
        ? new Int16Array(alignedBuf, 0, numPixels)
        : new Uint16Array(alignedBuf, 0, numPixels);

    for (let i = 0; i < numPixels; i++) {
      rescaled[i] = src[i] * rescaleSlope + rescaleIntercept;
    }
  } else {
    return null;
  }

  return rescaled;
}

/**
 * Estimates the Rician background air noise floor of an MRI slice by sampling
 * the 4 corner patches (12% x 12%) and taking the 2nd lowest corner's 92nd percentile.
 * Because extremity anatomy can enter at most 1-2 corners of the FOV, the 2nd lowest
 * corner is guaranteed to be pure background air.
 */
function estimateAirNoiseFloor(
  rescaled: Float32Array,
  rows: number,
  cols: number
): number {
  const pw = Math.max(6, Math.min(24, Math.floor(cols * 0.12)));
  const ph = Math.max(6, Math.min(24, Math.floor(rows * 0.12)));
  if (cols < pw * 2 || rows < ph * 2) {
    return 0;
  }

  const corners: Array<[number, number]> = [
    [0, 0],
    [cols - pw, 0],
    [0, rows - ph],
    [cols - pw, rows - ph],
  ];

  const cornerP92: number[] = [];
  for (const [startX, startY] of corners) {
    const vals: number[] = [];
    for (let y = startY; y < startY + ph; y++) {
      const rowOffset = y * cols;
      for (let x = startX; x < startX + pw; x++) {
        vals.push(rescaled[rowOffset + x]);
      }
    }
    vals.sort((a, b) => a - b);
    cornerP92.push(vals[Math.floor(vals.length * 0.92)] ?? 0);
  }

  cornerP92.sort((a, b) => a - b);
  return Math.max(0, cornerP92[1] ?? 0);
}

/**
 * Applies DICOM VOI LUT windowing (WindowCenter / WindowWidth) with Rician air-noise floor
 * suppression and a subtle soft-tissue perceptual curve to convert rescaled grayscale pixel data
 * into an 8-bit Uint8Array (0..255).
 */
function applyWindowingTo8Bit(
  rescaled: Float32Array,
  photometricInterpretation: string,
  windowCenter?: number,
  windowWidth?: number,
  airNoiseFloor = 0,
  gamma = 1.0
): Uint8Array {
  const numPixels = rescaled.length;
  let lower: number;
  let upper: number;

  if (
    windowCenter !== undefined &&
    windowWidth !== undefined &&
    windowWidth > 0
  ) {
    lower = windowCenter - windowWidth / 2;
    upper = windowCenter + windowWidth / 2;
  } else {
    const nonZero: number[] = [];
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < numPixels; i++) {
      const v = rescaled[i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
      if (v > 0) nonZero.push(v);
    }
    if (nonZero.length > 10) {
      nonZero.sort((a, b) => a - b);
      lower = nonZero[Math.floor(nonZero.length * 0.01)];
      upper = nonZero[Math.floor(nonZero.length * 0.995)];
    } else {
      lower = minVal;
      upper = maxVal;
    }
  }

  const invert = photometricInterpretation === "MONOCHROME1";
  if (!invert && airNoiseFloor > 0 && upper > airNoiseFloor * 2.5) {
    // Prevent negative DICOM lower window bounds from mapping zero/air noise to gray static
    lower = Math.max(0, airNoiseFloor * 1.12, lower);
  }

  const range = upper - lower > 0 ? upper - lower : 1;
  const out = new Uint8Array(numPixels);

  for (let i = 0; i < numPixels; i++) {
    const v = rescaled[i];
    let norm: number;
    if (v <= lower) {
      norm = 0;
    } else if (v >= upper) {
      norm = 255;
    } else {
      const t = (v - lower) / range;
      norm = Math.round((gamma !== 1.0 ? Math.pow(t, gamma) : t) * 255);
      if (!invert && airNoiseFloor > 0 && norm < 5) {
        norm = 0;
      }
    }
    out[i] = invert ? 255 - norm : norm;
  }

  return out;
}

interface RawParsedSlice extends DicomSlice {
  rescaledPixels: Float32Array;
  photometric: string;
  airNoiseFloor: number;
}

function parseRawSlice(filePath: string): RawParsedSlice | null {
  try {
    const fileBuf = fs.readFileSync(filePath);
    const byteArray = new Uint8Array(
      fileBuf.buffer,
      fileBuf.byteOffset,
      fileBuf.byteLength
    );
    const dataSet = dicomParser.parseDicom(byteArray);

    const modality = readCleanString(dataSet, "x00080060").toUpperCase();
    if (modality === "SR" || modality === "PR" || modality === "KO") {
      return null;
    }

    const rows = dataSet.uint16("x00280010") ?? 0;
    const cols = dataSet.uint16("x00280011") ?? 0;
    const bitsAllocated = dataSet.uint16("x00280100") ?? 16;
    const pixelRepresentation = dataSet.uint16("x00280103") ?? 0;
    const photometric = readCleanString(
      dataSet,
      "x00280004",
      "MONOCHROME2"
    ).toUpperCase();

    if (rows === 0 || cols === 0) {
      return null;
    }

    const windowCenter = readFirstFloat(dataSet, "x00281050");
    const windowWidth = readFirstFloat(dataSet, "x00281051");
    const rescaleIntercept = readFirstFloat(dataSet, "x00281052") ?? 0;
    const rescaleSlope = readFirstFloat(dataSet, "x00281053") ?? 1;

    const psArr = readFloatArray(dataSet, "x00280030", 2);
    const pixelSpacing: [number, number] | undefined =
      psArr && psArr[0] > 0 && psArr[1] > 0
        ? [psArr[0], psArr[1]]
        : undefined;

    const ippArr = readFloatArray(dataSet, "x00200032", 3);
    const imagePositionPatient: [number, number, number] | undefined = ippArr
      ? [ippArr[0], ippArr[1], ippArr[2]]
      : undefined;

    const iopArr = readFloatArray(dataSet, "x00200037", 6);
    const imageOrientationPatient:
      | [number, number, number, number, number, number]
      | undefined = iopArr
      ? [iopArr[0], iopArr[1], iopArr[2], iopArr[3], iopArr[4], iopArr[5]]
      : undefined;

    let sliceLocation = readFirstFloat(dataSet, "x00201041");
    if (
      sliceLocation === undefined &&
      imagePositionPatient &&
      imageOrientationPatient
    ) {
      const [rx, ry, rz, cx, cy, cz] = imageOrientationPatient;
      const nx = ry * cz - rz * cy;
      const ny = rz * cx - rx * cz;
      const nz = rx * cy - ry * cx;
      sliceLocation =
        imagePositionPatient[0] * nx +
        imagePositionPatient[1] * ny +
        imagePositionPatient[2] * nz;
    }

    const rescaledPixels = extractRescaledPixels(
      dataSet,
      rows,
      cols,
      bitsAllocated,
      pixelRepresentation,
      rescaleSlope,
      rescaleIntercept
    );

    if (!rescaledPixels) {
      return null;
    }

    const airNoiseFloor =
      modality === "MR"
        ? estimateAirNoiseFloor(rescaledPixels, rows, cols)
        : 0;

    const pixels8Bit = applyWindowingTo8Bit(
      rescaledPixels,
      photometric,
      windowCenter,
      windowWidth,
      airNoiseFloor,
      modality === "MR" ? 0.92 : 1.0
    );

    const studyDescription = readCleanString(
      dataSet,
      "x00081030",
      "Unnamed Study"
    );
    const seriesDescription = readCleanString(
      dataSet,
      "x0008103e",
      "Unnamed Series"
    );
    const protocolName = readCleanString(
      dataSet,
      "x00181030",
      seriesDescription
    );
    const bodyPartExamined = readCleanString(dataSet, "x00180015", "UNKNOWN");
    const sliceThickness = readCleanString(dataSet, "x00180050", "N/A");
    const seriesNumber = readIntString(dataSet, "x00200011", 0);
    const instanceNumber = readIntString(dataSet, "x00200013", 0);

    return {
      filePath,
      modality,
      studyDescription,
      seriesDescription,
      protocolName,
      bodyPartExamined,
      sliceThickness,
      seriesNumber,
      instanceNumber,
      rows,
      cols,
      windowCenter,
      windowWidth,
      pixelSpacing,
      sliceLocation,
      imagePositionPatient,
      imageOrientationPatient,
      pixels8Bit,
      rescaledPixels,
      photometric,
      airNoiseFloor,
    };
  } catch {
    return null;
  }
}

/**
 * Parses a single DICOM file (e.g., X-Ray CR/DX) and returns the windowed 8-bit slice.
 */
export function parseDicomSlice(filePath: string): DicomSlice | null {
  const raw = parseRawSlice(filePath);
  if (!raw) return null;
  const {
    rescaledPixels: _,
    photometric: __,
    airNoiseFloor: ___,
    ...slice
  } = raw;
  return slice;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Computes a consistent 3D union ROI bounding box across all slices in an MRI series
 * to trim empty black air margins around the anatomy while keeping all slices in the
 * series spatially aligned at identical dimensions.
 */
export function computeSeriesCropBox(
  slices: DicomSlice[],
  cols: number,
  rows: number
): CropBox {
  if (slices.length === 0 || cols < 32 || rows < 32) {
    return { left: 0, top: 0, width: cols, height: rows };
  }

  const colEnergy = new Float64Array(cols);
  const rowEnergy = new Float64Array(rows);

  for (const slice of slices) {
    const px = slice.pixels8Bit;
    for (let y = 6; y < rows - 6; y++) {
      const rowOffset = y * cols;
      for (let x = 6; x < cols - 6; x++) {
        const val = px[rowOffset + x];
        if (val > 36) {
          // Verify 3x3 neighborhood to ignore isolated single-pixel noise spikes or faint phase ghosts
          let sum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const nr = (y + dy) * cols;
            sum += px[nr + x - 1] + px[nr + x] + px[nr + x + 1];
          }
          if (sum >= 9 * 34) {
            colEnergy[x] += val;
            rowEnergy[y] += val;
          }
        }
      }
    }
  }

  let maxCol = 0;
  for (let x = 0; x < cols; x++) {
    if (colEnergy[x] > maxCol) maxCol = colEnergy[x];
  }
  let maxRow = 0;
  for (let y = 0; y < rows; y++) {
    if (rowEnergy[y] > maxRow) maxRow = rowEnergy[y];
  }

  if (maxCol <= 0 || maxRow <= 0) {
    return { left: 0, top: 0, width: cols, height: rows };
  }

  const colThresh = maxCol * 0.04;
  const rowThresh = maxRow * 0.04;

  let minX = 0;
  while (minX < cols - 1 && colEnergy[minX] < colThresh) minX++;
  let maxX = cols - 1;
  while (maxX > minX && colEnergy[maxX] < colThresh) maxX--;

  let minY = 0;
  while (minY < rows - 1 && rowEnergy[minY] < rowThresh) minY++;
  let maxY = rows - 1;
  while (maxY > minY && rowEnergy[maxY] < rowThresh) maxY--;

  const rawW = maxX - minX + 1;
  const rawH = maxY - minY + 1;
  const padX = Math.max(6, Math.round(rawW * 0.08));
  const padY = Math.max(6, Math.round(rawH * 0.08));

  let left = Math.max(0, minX - padX);
  let top = Math.max(0, minY - padY);
  let right = Math.min(cols, maxX + 1 + padX);
  let bottom = Math.min(rows, maxY + 1 + padY);

  // Enforce a minimum crop size of 42% of original dimensions so tiny slices aren't over-cropped
  const minW = Math.round(cols * 0.42);
  const minH = Math.round(rows * 0.42);
  if (right - left < minW) {
    const cx = Math.round((left + right) / 2);
    left = Math.max(0, Math.min(cols - minW, cx - Math.floor(minW / 2)));
    right = Math.min(cols, left + minW);
  }
  if (bottom - top < minH) {
    const cy = Math.round((top + bottom) / 2);
    top = Math.max(0, Math.min(rows - minH, cy - Math.floor(minH / 2)));
    bottom = Math.min(rows, top + minH);
  }

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Parses a list of MRI DICOM file paths, filters out non-MR / non-image files,
 * groups them by `seriesNumber` + `seriesDescription`, sorts slices ascending by `instanceNumber`,
 * stabilizes series-wide windowing, suppresses Rician air noise, and computes the 3D ROI crop box.
 */
export function parseAndGroupMriSeries(filePaths: string[]): MriSeriesGroup[] {
  const seriesMap = new Map<
    string,
    {
      meta: Omit<MriSeriesGroup, "slices" | "cropBox">;
      rawSlices: RawParsedSlice[];
    }
  >();

  for (const filePath of filePaths) {
    const raw = parseRawSlice(filePath);
    if (!raw || raw.modality !== "MR") {
      continue;
    }

    const key = `${raw.seriesNumber}::${raw.seriesDescription}`;
    let entry = seriesMap.get(key);
    if (!entry) {
      entry = {
        meta: {
          seriesNumber: raw.seriesNumber,
          seriesDescription: raw.seriesDescription,
          protocolName: raw.protocolName,
          studyDescription: raw.studyDescription,
          bodyPartExamined: raw.bodyPartExamined,
          sliceThickness: raw.sliceThickness,
          rows: raw.rows,
          cols: raw.cols,
          pixelSpacing: raw.pixelSpacing,
          imageOrientationPatient: raw.imageOrientationPatient,
        },
        rawSlices: [],
      };
      seriesMap.set(key, entry);
    }
    entry.rawSlices.push(raw);
  }

  const groups: MriSeriesGroup[] = [];

  for (const entry of seriesMap.values()) {
    entry.rawSlices.sort((a, b) => a.instanceNumber - b.instanceNumber);

    const wcs = entry.rawSlices
      .map((s) => s.windowCenter)
      .filter((v): v is number => v !== undefined && v > 0);
    const wws = entry.rawSlices
      .map((s) => s.windowWidth)
      .filter((v): v is number => v !== undefined && v > 0);
    const airFloors = entry.rawSlices
      .map((s) => s.airNoiseFloor)
      .filter((v) => v > 0);

    const medianWc = median(wcs);
    const medianWw = median(wws);
    const medianAirFloor = median(airFloors) ?? 0;

    const finalSlices: DicomSlice[] = entry.rawSlices.map((raw) => {
      let wc = raw.windowCenter;
      let ww = raw.windowWidth;

      // Stabilize peripheral/toe/fingertip slices against series median window so
      // narrow auto-windows on small cross-sections do not amplify background static
      // or cause abrupt brightness shifts between adjacent slices.
      if (
        medianWc !== undefined &&
        medianWw !== undefined &&
        wc !== undefined &&
        ww !== undefined
      ) {
        if (wc < medianWc * 0.72) {
          wc = medianWc * 0.78;
          ww = Math.max(ww, medianWw * 0.78);
        } else if (wc > medianWc * 1.35) {
          wc = medianWc * 1.25;
          ww = Math.min(ww, medianWw * 1.25);
        }
      }

      const sliceAirFloor = Math.max(raw.airNoiseFloor, medianAirFloor * 0.85);

      const pixels8Bit = applyWindowingTo8Bit(
        raw.rescaledPixels,
        raw.photometric,
        wc,
        ww,
        sliceAirFloor,
        0.92
      );

      return {
        filePath: raw.filePath,
        modality: raw.modality,
        studyDescription: raw.studyDescription,
        seriesDescription: raw.seriesDescription,
        protocolName: raw.protocolName,
        bodyPartExamined: raw.bodyPartExamined,
        sliceThickness: raw.sliceThickness,
        seriesNumber: raw.seriesNumber,
        instanceNumber: raw.instanceNumber,
        rows: raw.rows,
        cols: raw.cols,
        windowCenter: wc,
        windowWidth: ww,
        pixelSpacing: raw.pixelSpacing,
        sliceLocation: raw.sliceLocation,
        imagePositionPatient: raw.imagePositionPatient,
        imageOrientationPatient: raw.imageOrientationPatient,
        pixels8Bit,
      };
    });

    const cropBox = computeSeriesCropBox(
      finalSlices,
      entry.meta.cols,
      entry.meta.rows
    );

    groups.push({
      ...entry.meta,
      cropBox,
      slices: finalSlices,
    });
  }

  groups.sort((a, b) => a.seriesNumber - b.seriesNumber);
  return groups;
}
