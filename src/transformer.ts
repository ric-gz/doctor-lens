import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { parseAndGroupMriSeries, parseDicomSlice } from "./dicom.js";
import { saveCacheManifest } from "./cache.js";
import type {
  CropBox,
  DicomSlice,
  DiscoveredAssets,
  MriSeriesGroup,
  MriSeriesMetadata,
  PairedMriSeriesMetadata,
  TransformationManifest,
  XrayAssetMetadata,
} from "./types.js";

const BANNER_HEIGHT = 56;
/**
 * Minimum longest-edge dimension for tiles in the full-series overview montage
 * after 3D ROI background cropping, so small native matrices are still crisp.
 */
const MIN_OVERVIEW_TILE_LONG_EDGE = 420;
/**
 * Minimum longest-edge dimension for high-resolution zoomed panels sent to Gemini.
 * Applied AFTER 3D ROI background cropping, using Lanczos3 + blended CLAHE + edge sharpening.
 */
const MIN_PANEL_TILE_LONG_EDGE = 768;
const SLICES_PER_HIGH_RES_PANEL = 6;
/**
 * Number of co-registered (T1 + PD-FS) slice pairs per side-by-side comparison panel.
 */
const PAIRS_PER_PAIRED_PANEL = 4;
const MIN_PAIRED_TILE_LONG_EDGE = 640;

function sanitizeForFilename(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const enhancedCropCache = new WeakMap<DicomSlice, Uint8Array>();

/**
 * Extracts the 1-channel cropped ROI subarray from a slice and blends 22% CLAHE
 * (Contrast Limited Adaptive Histogram Equalization) at native cropped resolution
 * while preserving pure black background air and true T1 / PD-FS signal ratios.
 * Cached per slice so overview montages, detail panels, and paired panels reuse it.
 */
async function getEnhancedCroppedPixels(
  slice: DicomSlice,
  cropBox: CropBox
): Promise<Uint8Array> {
  const cached = enhancedCropCache.get(slice);
  if (cached) {
    return cached;
  }

  const { left, top, width: cw, height: ch } = cropBox;
  const cropped = new Uint8Array(cw * ch);
  const src = slice.pixels8Bit;
  const srcCols = slice.cols;

  for (let y = 0; y < ch; y++) {
    const srcRowStart = (top + y) * srcCols + left;
    const dstRowStart = y * cw;
    cropped.set(src.subarray(srcRowStart, srcRowStart + cw), dstRowStart);
  }

  const claheRaw = await sharp(cropped, {
    raw: {
      width: cw,
      height: ch,
      channels: 1,
    },
  })
    .clahe({
      width: 32,
      height: 32,
      maxSlope: 2,
    })
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  const blended = new Uint8Array(cw * ch);
  for (let i = 0; i < blended.length; i++) {
    const b = cropped[i];
    if (b <= 3) {
      blended[i] = 0;
    } else {
      blended[i] = Math.min(255, Math.round(b * 0.78 + claheRaw[i] * 0.22));
    }
  }

  enhancedCropCache.set(slice, blended);
  return blended;
}

/**
 * Upscales the 1-channel ROI-cropped and CLAHE-enhanced slice to `tileWidth x tileHeight`
 * using Lanczos3 interpolation and applies a fast, subtle medical edge sharpen.
 */
async function renderEnhancedSliceTile(
  slice: DicomSlice,
  cropBox: CropBox,
  tileWidth: number,
  tileHeight: number
): Promise<Buffer> {
  const enhancedCropped = await getEnhancedCroppedPixels(slice, cropBox);

  return sharp(enhancedCropped, {
    raw: {
      width: cropBox.width,
      height: cropBox.height,
      channels: 1,
    },
  })
    .resize(tileWidth, tileHeight, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .sharpen()
    .png()
    .toBuffer();
}

/**
 * Builds the SVG overlay for a single slice tile, including:
 * - Top-left badge with `#instanceNumber` (or custom label) + `SliceLocation` in mm
 * - Bottom-right calibrated millimeter scale bar (`10 mm` or `5 mm` with midpoint tick)
 *   computed from DICOM `PixelSpacing (0028,0030)` and the active ROI crop/upscale factor.
 */
function buildTileOverlaySvg(
  slice: DicomSlice,
  cropBox: CropBox,
  tileWidth: number,
  tileHeight: number,
  customPrimaryLabel?: string,
  primaryColor = "#38BDF8"
): Buffer {
  const primaryText = escapeXml(
    customPrimaryLabel ?? `#${slice.instanceNumber}`
  );
  const locText =
    slice.sliceLocation !== undefined
      ? escapeXml(
          `${slice.sliceLocation >= 0 ? "+" : ""}${slice.sliceLocation.toFixed(
            1
          )}mm`
        )
      : "";

  const badgeHeight = Math.max(26, Math.min(38, Math.round(tileHeight * 0.065)));
  const labelFontSize = Math.max(13, Math.round(badgeHeight * 0.56));
  const locFontSize = Math.max(11, Math.round(labelFontSize * 0.84));

  const primaryCharWidth = Math.round(labelFontSize * 0.62);
  const locCharWidth = Math.round(locFontSize * 0.58);
  const primaryWidth = primaryText.length * primaryCharWidth + 16;
  const locWidth = locText ? locText.length * locCharWidth + 12 : 0;
  const badgeWidth = Math.min(
    tileWidth - 12,
    Math.max(54, primaryWidth + locWidth)
  );
  const textY = 6 + Math.round(badgeHeight * 0.72);

  let scaleBarSvg = "";
  if (slice.pixelSpacing && slice.pixelSpacing[1] > 0) {
    const colSpacingMm = slice.pixelSpacing[1];
    const renderScale = tileWidth / cropBox.width;
    const pxPerMm = renderScale / colSpacingMm;

    let barMm = 10;
    if (10 * pxPerMm > tileWidth * 0.36) {
      barMm = 5;
    } else if (10 * pxPerMm < 28) {
      barMm = 20;
    }
    const barPx = Math.round(barMm * pxPerMm);

    if (barPx >= 20 && barPx <= tileWidth * 0.5) {
      const boxPadX = 8;
      const boxW = barPx + boxPadX * 2;
      const boxH = Math.max(24, Math.round(badgeHeight * 0.85));
      const boxX = tileWidth - boxW - 6;
      const boxY = tileHeight - boxH - 6;
      const barY = boxY + boxH - 7;
      const barX1 = boxX + boxPadX;
      const barX2 = barX1 + barPx;
      const barMidX = Math.round((barX1 + barX2) / 2);
      const scaleFontSize = Math.max(10, Math.round(boxH * 0.44));

      scaleBarSvg = `
        <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="4" fill="#000000" fill-opacity="0.74"/>
        <text x="${barMidX}" y="${boxY + Math.round(boxH * 0.52)}" text-anchor="middle" fill="#E5E7EB" font-family="sans-serif" font-size="${scaleFontSize}" font-weight="bold">${barMm} mm</text>
        <line x1="${barX1}" y1="${barY}" x2="${barX2}" y2="${barY}" stroke="#38BDF8" stroke-width="2"/>
        <line x1="${barX1}" y1="${barY - 4}" x2="${barX1}" y2="${barY + 2}" stroke="#38BDF8" stroke-width="2"/>
        <line x1="${barMidX}" y1="${barY - 3}" x2="${barMidX}" y2="${barY + 1}" stroke="#38BDF8" stroke-width="1.5"/>
        <line x1="${barX2}" y1="${barY - 4}" x2="${barX2}" y2="${barY + 2}" stroke="#38BDF8" stroke-width="2"/>
      `;
    }
  }

  return Buffer.from(
    `<svg width="${tileWidth}" height="${tileHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="6" y="6" width="${badgeWidth}" height="${badgeHeight}" rx="4" fill="#000000" fill-opacity="0.76"/>
      <text x="12" y="${textY}" fill="${primaryColor}" font-family="sans-serif" font-size="${labelFontSize}" font-weight="bold">${primaryText}</text>
      ${
        locText
          ? `<text x="${12 + primaryWidth - 4}" y="${textY}" fill="#D1D5DB" font-family="sans-serif" font-size="${locFontSize}">${locText}</text>`
          : ""
      }
      ${scaleBarSvg}
      <rect x="0" y="0" width="${tileWidth}" height="${tileHeight}" fill="none" stroke="#374151" stroke-width="1"/>
    </svg>`
  );
}

/**
 * Renders a grid image from a subset (or full set) of slices using the series 3D ROI crop box
 * and specified output tile dimensions.
 */
async function renderSliceGridImage(
  slices: DicomSlice[],
  cropBox: CropBox,
  tileWidth: number,
  tileHeight: number,
  gridCols: number,
  bannerText: string,
  outputPath: string
): Promise<void> {
  const sliceCount = slices.length;
  const gridRows = Math.ceil(sliceCount / gridCols);
  const canvasWidth = gridCols * tileWidth;
  const canvasHeight = BANNER_HEIGHT + gridRows * tileHeight;

  const compositeInputs: sharp.OverlayOptions[] = [];

  const escapedBanner = escapeXml(bannerText);
  const fontSize = canvasWidth >= 1400 ? 22 : 17;
  const bannerSvg = Buffer.from(
    `<svg width="${canvasWidth}" height="${BANNER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#111827"/>
      <text x="18" y="36" fill="#F9FAFB" font-family="sans-serif" font-size="${fontSize}" font-weight="bold">${escapedBanner}</text>
    </svg>`
  );
  compositeInputs.push({ input: bannerSvg, left: 0, top: 0 });

  const tileBuffers = await Promise.all(
    slices.map((slice) =>
      renderEnhancedSliceTile(slice, cropBox, tileWidth, tileHeight)
    )
  );

  for (let idx = 0; idx < sliceCount; idx++) {
    const slice = slices[idx];
    const colIdx = idx % gridCols;
    const rowIdx = Math.floor(idx / gridCols);
    const left = colIdx * tileWidth;
    const top = BANNER_HEIGHT + rowIdx * tileHeight;

    compositeInputs.push({ input: tileBuffers[idx], left, top });

    const overlaySvg = buildTileOverlaySvg(
      slice,
      cropBox,
      tileWidth,
      tileHeight,
      `#${slice.instanceNumber || idx + 1}`
    );
    compositeInputs.push({ input: overlaySvg, left, top });
  }

  await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(compositeInputs)
    .png({ compressionLevel: 6 })
    .toFile(outputPath);
}

/**
 * Filters out pure-air edge slices at the very beginning/end of a series when building
 * high-resolution zoom panels, while keeping all anatomical slices.
 */
function selectAnatomicalSlices(slices: DicomSlice[]): DicomSlice[] {
  if (slices.length <= 6) {
    return slices;
  }

  const hasAnatomy = slices.map((s) => {
    let brightCount = 0;
    const total = s.pixels8Bit.length;
    for (let i = 0; i < total; i++) {
      if (s.pixels8Bit[i] > 35) {
        brightCount++;
      }
    }
    return brightCount / total >= 0.012;
  });

  const firstIdx = hasAnatomy.indexOf(true);
  const lastIdx = hasAnatomy.lastIndexOf(true);

  if (firstIdx === -1 || lastIdx === -1 || lastIdx < firstIdx) {
    return slices;
  }

  const start = Math.max(0, firstIdx - 1);
  const end = Math.min(slices.length - 1, lastIdx + 1);
  return slices.slice(start, end + 1);
}

/**
 * Renders both:
 * 1. A 3D-ROI-cropped full-series overview montage (`mri-series-<N>-<desc>.png`), and
 * 2. High-resolution Lanczos3 + CLAHE + sharpened zoomed sub-panels (`mri-series-<N>-<desc>-panel-<P>.png`,
 *    6 slices per panel, >= 768px long edge) with calibrated 10 mm scale bars and slice locations.
 */
async function renderMriSeriesMontageAndPanels(
  group: MriSeriesGroup,
  outputDir: string
): Promise<MriSeriesMetadata> {
  const sliceCount = group.slices.length;
  const sanitizedDesc = sanitizeForFilename(group.seriesDescription);
  const { cropBox } = group;

  // 1. Full-series overview montage using 3D ROI crop + minimum 420px long edge
  const fullGridCols = Math.ceil(Math.sqrt(sliceCount));
  const montageFile = `mri-series-${group.seriesNumber}-${sanitizedDesc}.png`;
  const montagePath = path.join(outputDir, montageFile);

  const maxCropDim = Math.max(cropBox.width, cropBox.height);
  const overviewScale = Math.max(1, MIN_OVERVIEW_TILE_LONG_EDGE / maxCropDim);
  const overviewTileWidth = Math.round(cropBox.width * overviewScale);
  const overviewTileHeight = Math.round(cropBox.height * overviewScale);

  const overviewTitle = `Series ${group.seriesNumber}: ${group.seriesDescription} — Full Overview (${sliceCount} slices, Thickness: ${group.sliceThickness}mm, ROI Crop ${cropBox.width}x${cropBox.height} from ${group.cols}x${group.rows})`;
  await renderSliceGridImage(
    group.slices,
    cropBox,
    overviewTileWidth,
    overviewTileHeight,
    fullGridCols,
    overviewTitle,
    montagePath
  );

  // 2. High-resolution zoomed panels (up to 6 anatomical slices per panel, upscaled to >= 768px long edge)
  const anatomicalSlices = selectAnatomicalSlices(group.slices);
  const upscaleFactor = Math.max(1, MIN_PANEL_TILE_LONG_EDGE / maxCropDim);
  const panelTileWidth = Math.round(cropBox.width * upscaleFactor);
  const panelTileHeight = Math.round(cropBox.height * upscaleFactor);

  // Choose panel grid columns based on cropped slice aspect ratio (2x3 or 3x2)
  const panelCols = cropBox.width > cropBox.height * 1.25 ? 2 : 3;

  const panelFiles: string[] = [];
  const totalPanels = Math.ceil(
    anatomicalSlices.length / SLICES_PER_HIGH_RES_PANEL
  );

  for (let p = 0; p < totalPanels; p++) {
    const chunk = anatomicalSlices.slice(
      p * SLICES_PER_HIGH_RES_PANEL,
      (p + 1) * SLICES_PER_HIGH_RES_PANEL
    );
    const firstSliceNum = chunk[0].instanceNumber;
    const lastSliceNum = chunk[chunk.length - 1].instanceNumber;
    const panelFile = `mri-series-${group.seriesNumber}-${sanitizedDesc}-panel-${p + 1}.png`;
    const panelPath = path.join(outputDir, panelFile);

    const panelTitle = `Series ${group.seriesNumber} (${group.seriesDescription}) — High-Res ROI Panel ${p + 1}/${totalPanels} (Slices #${firstSliceNum} to #${lastSliceNum}, ${panelTileWidth}x${panelTileHeight}/slice)`;
    await renderSliceGridImage(
      chunk,
      cropBox,
      panelTileWidth,
      panelTileHeight,
      Math.min(panelCols, chunk.length),
      panelTitle,
      panelPath
    );
    panelFiles.push(panelFile);
  }

  return {
    seriesNumber: group.seriesNumber,
    seriesDescription: group.seriesDescription,
    protocolName: group.protocolName,
    sliceThickness: group.sliceThickness,
    sliceCount,
    rows: group.rows,
    cols: group.cols,
    croppedCols: cropBox.width,
    croppedRows: cropBox.height,
    pixelSpacingMm: group.pixelSpacing,
    montageFile,
    panelFiles,
  };
}

function computeSliceNormal(
  iop?: [number, number, number, number, number, number]
): [number, number, number] | null {
  if (!iop) return null;
  const [rx, ry, rz, cx, cy, cz] = iop;
  const nx = ry * cz - rz * cy;
  const ny = rz * cx - rx * cz;
  const nz = rx * cy - ry * cx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-4) return null;
  return [nx / len, ny / len, nz / len];
}

function hasToken(text: string, tokenPattern: string): boolean {
  const re = new RegExp(`(?:^|[^a-z0-9])(${tokenPattern})(?:$|[^a-z0-9])`, "i");
  return re.test(text);
}

function inferAnatomicalPlaneLabel(group: MriSeriesGroup): string {
  const text = `${group.seriesDescription} ${group.protocolName}`.toLowerCase();
  if (hasToken(text, "cor|coronal")) return "coronal";
  if (hasToken(text, "sag|sagittal")) return "sagittal";
  if (hasToken(text, "tra|ax|axial|trans")) return "axial";

  const n = computeSliceNormal(group.imageOrientationPatient);
  if (n) {
    const absX = Math.abs(n[0]);
    const absY = Math.abs(n[1]);
    const absZ = Math.abs(n[2]);
    if (absX >= absY && absX >= absZ) return "sagittal";
    if (absY >= absX && absY >= absZ) return "coronal";
    return "axial";
  }
  return "plane";
}

function isT1Weighted(group: MriSeriesGroup): boolean {
  const text = `${group.seriesDescription} ${group.protocolName}`.toLowerCase();
  return (
    hasToken(text, "t1") && !hasToken(text, "fs|fatsat|stir|tirm|water")
  );
}

function isFluidSensitive(group: MriSeriesGroup): boolean {
  const text = `${group.seriesDescription} ${group.protocolName}`.toLowerCase();
  return (
    hasToken(text, "pd|t2|stir|tirm|fs|fatsat") && !hasToken(text, "t1")
  );
}

function areSamePlane(a: MriSeriesGroup, b: MriSeriesGroup): boolean {
  const na = computeSliceNormal(a.imageOrientationPatient);
  const nb = computeSliceNormal(b.imageOrientationPatient);
  if (na && nb) {
    const dot = Math.abs(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]);
    return dot >= 0.96;
  }
  return inferAnatomicalPlaneLabel(a) === inferAnatomicalPlaneLabel(b);
}

interface MatchedSlicePair {
  t1Slice: DicomSlice;
  fluidSlice: DicomSlice;
  locationMm: number;
  deltaMm: number;
}

/**
 * Renders side-by-side co-registered T1 + Fluid-Sensitive (PD-FS/T2-FS) comparison panels
 * for matching anatomical planes so Gemini (and human readers) can cross-reference T1 vs.
 * fluid-sensitive signal at identical slice locations instantaneously.
 */
async function discoverAndRenderPairedSeries(
  groups: MriSeriesGroup[],
  outputDir: string
): Promise<PairedMriSeriesMetadata[]> {
  const t1Groups = groups.filter(isT1Weighted);
  const fluidGroups = groups.filter(isFluidSensitive);
  const usedFluidSeries = new Set<number>();
  const pairedResults: PairedMriSeriesMetadata[] = [];

  for (const t1Group of t1Groups) {
    const t1Anat = selectAnatomicalSlices(t1Group.slices).filter(
      (s) => s.sliceLocation !== undefined
    );
    if (t1Anat.length < 4) continue;

    const thickT1 = Number.parseFloat(t1Group.sliceThickness) || 3.0;

    let bestFluidGroup: MriSeriesGroup | null = null;
    let bestPairs: MatchedSlicePair[] = [];

    for (const fluidGroup of fluidGroups) {
      if (usedFluidSeries.has(fluidGroup.seriesNumber)) continue;
      if (!areSamePlane(t1Group, fluidGroup)) continue;

      const fluidAnat = selectAnatomicalSlices(fluidGroup.slices).filter(
        (s) => s.sliceLocation !== undefined
      );
      if (fluidAnat.length < 4) continue;

      const thickFluid = Number.parseFloat(fluidGroup.sliceThickness) || 3.0;
      const maxDeltaMm = Math.max(thickT1, thickFluid, 2.5) * 0.75;

      const candidatePairs: MatchedSlicePair[] = [];
      const usedFluidSliceNums = new Set<number>();

      for (const t1Slice of t1Anat) {
        const loc1 = t1Slice.sliceLocation!;
        let closest: DicomSlice | null = null;
        let minDelta = Infinity;

        for (const fSlice of fluidAnat) {
          if (usedFluidSliceNums.has(fSlice.instanceNumber)) continue;
          const delta = Math.abs(loc1 - fSlice.sliceLocation!);
          if (delta <= maxDeltaMm && delta < minDelta) {
            minDelta = delta;
            closest = fSlice;
          }
        }

        if (closest) {
          usedFluidSliceNums.add(closest.instanceNumber);
          candidatePairs.push({
            t1Slice,
            fluidSlice: closest,
            locationMm: (loc1 + closest.sliceLocation!) / 2,
            deltaMm: minDelta,
          });
        }
      }

      if (candidatePairs.length > bestPairs.length && candidatePairs.length >= 4) {
        bestPairs = candidatePairs;
        bestFluidGroup = fluidGroup;
      }
    }

    if (!bestFluidGroup || bestPairs.length < 4) {
      continue;
    }

    usedFluidSeries.add(bestFluidGroup.seriesNumber);
    const plane = inferAnatomicalPlaneLabel(t1Group);

    // Determine tile dimensions for T1 and Fluid slices so both have identical tile height
    const t1Crop = t1Group.cropBox;
    const fluidCrop = bestFluidGroup.cropBox;

    const t1MaxDim = Math.max(t1Crop.width, t1Crop.height);
    const t1Scale = Math.max(1, MIN_PAIRED_TILE_LONG_EDGE / t1MaxDim);
    const tileHeight = Math.round(t1Crop.height * t1Scale);
    const t1TileWidth = Math.round(t1Crop.width * t1Scale);
    const fluidTileWidth = Math.round(
      fluidCrop.width * (tileHeight / fluidCrop.height)
    );

    const pairHeaderHeight = 32;
    const pairWidth = t1TileWidth + fluidTileWidth;
    const pairHeight = pairHeaderHeight + tileHeight;

    // Use 1 column of pairs if each pair is very wide (e.g. axial fingers), else 2 columns of pairs
    const pairGridCols = pairWidth >= 1450 ? 1 : 2;
    const totalPanels = Math.ceil(bestPairs.length / PAIRS_PER_PAIRED_PANEL);
    const panelFiles: string[] = [];

    for (let p = 0; p < totalPanels; p++) {
      const chunk = bestPairs.slice(
        p * PAIRS_PER_PAIRED_PANEL,
        (p + 1) * PAIRS_PER_PAIRED_PANEL
      );
      const gridCols = Math.min(pairGridCols, chunk.length);
      const gridRows = Math.ceil(chunk.length / gridCols);
      const canvasWidth = gridCols * pairWidth;
      const canvasHeight = BANNER_HEIGHT + gridRows * pairHeight;

      const compositeInputs: sharp.OverlayOptions[] = [];

      const firstPair = chunk[0];
      const lastPair = chunk[chunk.length - 1];
      const bannerTitle = escapeXml(
        `Co-Registered ${plane.toUpperCase()} Pair — Series ${t1Group.seriesNumber} (${t1Group.seriesDescription} [T1]) vs Series ${bestFluidGroup.seriesNumber} (${bestFluidGroup.seriesDescription} [FS]) — Panel ${p + 1}/${totalPanels} (Loc ${firstPair.locationMm.toFixed(1)}mm to ${lastPair.locationMm.toFixed(1)}mm)`
      );
      const bannerFontSize = canvasWidth >= 1500 ? 20 : 16;

      const bannerSvg = Buffer.from(
        `<svg width="${canvasWidth}" height="${BANNER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#0F172A"/>
          <text x="18" y="36" fill="#F8FAFC" font-family="sans-serif" font-size="${bannerFontSize}" font-weight="bold">${bannerTitle}</text>
        </svg>`
      );
      compositeInputs.push({ input: bannerSvg, left: 0, top: 0 });

      const renderedPairs = await Promise.all(
        chunk.map((pair) =>
          Promise.all([
            renderEnhancedSliceTile(
              pair.t1Slice,
              t1Crop,
              t1TileWidth,
              tileHeight
            ),
            renderEnhancedSliceTile(
              pair.fluidSlice,
              fluidCrop,
              fluidTileWidth,
              tileHeight
            ),
          ])
        )
      );

      for (let idx = 0; idx < chunk.length; idx++) {
        const pair = chunk[idx];
        const [t1Buf, fluidBuf] = renderedPairs[idx];
        const colIdx = idx % gridCols;
        const rowIdx = Math.floor(idx / gridCols);
        const pairLeft = colIdx * pairWidth;
        const pairTop = BANNER_HEIGHT + rowIdx * pairHeight;

        const headerLabel = escapeXml(
          `Level ${pair.locationMm >= 0 ? "+" : ""}${pair.locationMm.toFixed(1)}mm  •  Left: S${t1Group.seriesNumber} #${pair.t1Slice.instanceNumber} (T1)   ⇄   Right: S${bestFluidGroup.seriesNumber} #${pair.fluidSlice.instanceNumber} (FS)`
        );
        const pairHeaderSvg = Buffer.from(
          `<svg width="${pairWidth}" height="${pairHeaderHeight}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" fill="#1E293B"/>
            <text x="${Math.round(pairWidth / 2)}" y="21" text-anchor="middle" fill="#FDE68A" font-family="sans-serif" font-size="14" font-weight="bold">${headerLabel}</text>
          </svg>`
        );
        compositeInputs.push({
          input: pairHeaderSvg,
          left: pairLeft,
          top: pairTop,
        });

        const tileTop = pairTop + pairHeaderHeight;

        compositeInputs.push({ input: t1Buf, left: pairLeft, top: tileTop });
        compositeInputs.push({
          input: fluidBuf,
          left: pairLeft + t1TileWidth,
          top: tileTop,
        });

        const t1Overlay = buildTileOverlaySvg(
          pair.t1Slice,
          t1Crop,
          t1TileWidth,
          tileHeight,
          `S${t1Group.seriesNumber} #${pair.t1Slice.instanceNumber} [T1]`,
          "#FBBF24"
        );
        const fluidOverlay = buildTileOverlaySvg(
          pair.fluidSlice,
          fluidCrop,
          fluidTileWidth,
          tileHeight,
          `S${bestFluidGroup.seriesNumber} #${pair.fluidSlice.instanceNumber} [FS]`,
          "#38BDF8"
        );

        compositeInputs.push({
          input: t1Overlay,
          left: pairLeft,
          top: tileTop,
        });
        compositeInputs.push({
          input: fluidOverlay,
          left: pairLeft + t1TileWidth,
          top: tileTop,
        });

        // Outer border around the co-registered pair
        const pairBorderSvg = Buffer.from(
          `<svg width="${pairWidth}" height="${pairHeight}" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="${pairWidth - 2}" height="${pairHeight - 2}" fill="none" stroke="#475569" stroke-width="2"/>
          </svg>`
        );
        compositeInputs.push({
          input: pairBorderSvg,
          left: pairLeft,
          top: pairTop,
        });
      }

      const panelFile = `mri-paired-s${t1Group.seriesNumber}-t1-vs-s${bestFluidGroup.seriesNumber}-fs-${plane}-panel-${p + 1}.png`;
      const panelPath = path.join(outputDir, panelFile);

      await sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .composite(compositeInputs)
        .png({ compressionLevel: 6 })
        .toFile(panelPath);

      panelFiles.push(panelFile);
    }

    pairedResults.push({
      plane,
      t1SeriesNumber: t1Group.seriesNumber,
      t1SeriesDescription: t1Group.seriesDescription,
      fluidSeriesNumber: bestFluidGroup.seriesNumber,
      fluidSeriesDescription: bestFluidGroup.seriesDescription,
      pairCount: bestPairs.length,
      panelFiles,
    });
  }

  return pairedResults;
}

/**
 * Processes and normalizes any X-Ray assets (both standard image files and DICOM CR/DX files)
 * into full-resolution PNG files inside `reports/<body-part-id>/montages/`.
 */
async function processXrayAssets(
  xrayImageFiles: string[],
  xrayDicomFiles: string[],
  outputDir: string
): Promise<XrayAssetMetadata[]> {
  const results: XrayAssetMetadata[] = [];
  let index = 1;

  for (const imgPath of xrayImageFiles) {
    const baseName = path.basename(imgPath, path.extname(imgPath));
    const sanitized = sanitizeForFilename(baseName);
    const outFile = `xray-${index}-${sanitized}.png`;
    const outPath = path.join(outputDir, outFile);

    const image = sharp(imgPath);
    const metadata = await image.metadata();
    await image.png().toFile(outPath);

    results.push({
      file: outFile,
      originalName: path.basename(imgPath),
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      sourceType: "image",
    });
    index++;
  }

  for (const dcmPath of xrayDicomFiles) {
    const slice = parseDicomSlice(dcmPath);
    if (!slice) continue;

    const baseName = path.basename(dcmPath);
    const sanitized = sanitizeForFilename(
      slice.seriesDescription || baseName || `dcm-${index}`
    );
    const outFile = `xray-${index}-${sanitized}.png`;
    const outPath = path.join(outputDir, outFile);

    await sharp(slice.pixels8Bit, {
      raw: {
        width: slice.cols,
        height: slice.rows,
        channels: 1,
      },
    })
      .png()
      .toFile(outPath);

    results.push({
      file: outFile,
      originalName: baseName,
      width: slice.cols,
      height: slice.rows,
      sourceType: "dicom",
      seriesDescription: slice.seriesDescription,
    });
    index++;
  }

  return results;
}

/**
 * Orchestrates the transformation of discovered MRI and X-Ray assets into 3D-ROI-cropped
 * PNG montages, high-resolution CLAHE/sharpened zoomed panels, and co-registered T1+FS paired panels,
 * persisting `manifest.json` in `reports/<body-part-id>/montages/`.
 */
export async function transformCaseAssets(
  bodyPartId: string,
  discovered: DiscoveredAssets,
  montagesDir: string
): Promise<TransformationManifest> {
  if (fs.existsSync(montagesDir)) {
    // Clean up stale montage PNGs before writing fresh v3 assets
    for (const entry of fs.readdirSync(montagesDir)) {
      if (entry.endsWith(".png")) {
        try {
          fs.unlinkSync(path.join(montagesDir, entry));
        } catch {
          // ignore
        }
      }
    }
  } else {
    fs.mkdirSync(montagesDir, { recursive: true });
  }

  const modalities: Array<"mri" | "x-ray"> = [];
  const mriSeriesMeta: MriSeriesMetadata[] = [];
  let pairedMriSeriesMeta: PairedMriSeriesMetadata[] = [];
  let studyDescription = bodyPartId;
  let bodyPartExamined = bodyPartId.toUpperCase();

  if (discovered.hasMri && discovered.mriDicomFiles.length > 0) {
    const mriGroups = parseAndGroupMriSeries(discovered.mriDicomFiles);
    if (mriGroups.length > 0) {
      modalities.push("mri");
      studyDescription = mriGroups[0].studyDescription || studyDescription;
      bodyPartExamined = mriGroups[0].bodyPartExamined || bodyPartExamined;

      for (const group of mriGroups) {
        const meta = await renderMriSeriesMontageAndPanels(group, montagesDir);
        mriSeriesMeta.push(meta);
      }

      pairedMriSeriesMeta = await discoverAndRenderPairedSeries(
        mriGroups,
        montagesDir
      );
    }
  }

  let xrayMeta: XrayAssetMetadata[] = [];
  if (
    discovered.hasXray &&
    (discovered.xrayImageFiles.length > 0 ||
      discovered.xrayDicomFiles.length > 0)
  ) {
    xrayMeta = await processXrayAssets(
      discovered.xrayImageFiles,
      discovered.xrayDicomFiles,
      montagesDir
    );
    if (xrayMeta.length > 0) {
      modalities.push("x-ray");
    }
  }

  if (mriSeriesMeta.length === 0 && xrayMeta.length === 0) {
    throw new Error(
      `No renderable MRI image series or X-Ray images were produced for case '${bodyPartId}'.`
    );
  }

  const manifest: TransformationManifest = {
    version: 3,
    bodyPartId,
    createdAt: new Date().toISOString(),
    studyDescription,
    bodyPartExamined,
    modalities,
    mriSeries: mriSeriesMeta,
    pairedMriSeries: pairedMriSeriesMeta,
    xrayImages: xrayMeta,
  };

  saveCacheManifest(montagesDir, manifest);
  return manifest;
}
