# Implementation Plan & Technical Specification (SDD - Stage 2 & 3)

## 1. Architecture Overview

**Doctor Lens** is a Node.js (TypeScript) CLI pipeline with 5 modular stages:
1. **CLI & Config Resolution (`src/cli.ts`, `src/config.ts`)** — Parses `--body-part-id` (both `npm_config_body_part_id` and CLI argv `--body-part-id`), validates `data/<body-part-id>`, and loads `GEMINI_API_KEY` and `GEMINI_MODEL`.
2. **Transformation Cache Manager (`src/cache.ts`)** — Checks `reports/<body-part-id>/montages/manifest.json` and verifies all referenced PNG files exist on disk. If valid, skips scanning and transformation completely.
3. **Asset Scanner & DICOM Parser (`src/scanner.ts`, `src/dicom.ts`)** — Scans `data/<body-part-id>/mri` (ignoring bundled viewer folders and non-image `SR` series) and `data/<body-part-id>/x-ray`. Extracts anonymized technical metadata and raw 16-bit pixel data using `dicom-parser`.
4. **Image Transformer & Montage Builder (`src/transformer.ts`)** — Applies VOI LUT (`WindowCenter`/`WindowWidth` or percentile auto-windowing) to map 16-bit `MONOCHROME2` pixels to 8-bit grayscale, overlays slice numbers, and uses `sharp` to composite each MRI series into a labeled grid montage PNG (plus normalized X-Ray PNGs). Saves images + `manifest.json` to `reports/<body-part-id>/montages/`.
5. **Gemini Diagnostic Reporter (`src/gemini.ts`, `src/report.ts`)** — Sends the cached/generated montage PNGs and structured sequence metadata to Google Gemini (`@google/genai`) with a specialized radiology prompt and writes the diagnostic report to `reports/<body-part-id>/report.md`.

---

## 2. Target Project Structure

```text
doctor-lens/
├── data/                           # Read-only input medical studies
│   ├── right-foot-1/
│   └── right-hand-2/
├── reports/                        # Generated outputs & transformation cache
│   └── <body-part-id>/
│       ├── montages/
│       │   ├── manifest.json       # Anonymized metadata & cached image index
│       │   ├── series-4-t1_tse_sag_s2.png
│       │   └── ...
│       └── report.md               # Final Gemini diagnostic report
├── src/
│   ├── index.ts                    # CLI entry point & pipeline orchestrator
│   ├── config.ts                   # CLI argument & env variable parser
│   ├── types.ts                    # Shared TypeScript interfaces
│   ├── cache.ts                    # Manifest read/write & cache validation
│   ├── scanner.ts                  # mri/ and x-ray/ asset discovery
│   ├── dicom.ts                    # DICOM header parsing, PII stripping, 16->8-bit windowing
│   ├── transformer.ts              # SVG label rendering & Sharp grid montage generation
│   ├── gemini.ts                   # @google/genai multimodal prompt & API call
│   └── report.ts                   # Report formatting & persistence
├── .env.example                    # Example environment configuration
├── .gitignore
├── package.json
├── tsconfig.json
├── requirements.md                 # SDD Stage 1: Requirements
├── implementation-plan.md          # SDD Stage 2/3: Architecture & Trackable Tasks
└── project-history.md              # Session log & decision history
```

---

## 3. Detailed Technical Specifications

### 3.1 Tech Stack & Dependencies
- **Runtime:** Node.js LTS (`lts-latest`, ESM TypeScript via `tsx`)
- **Production Dependencies:**
  - `dicom-parser`: Parse DICOM Part 10 files (`Explicit VR Little Endian`)
  - `sharp`: High-speed image resizing, SVG text overlay, and grid compositing
  - `@google/genai`: Official Google Gemini SDK
  - `dotenv`: Load `GEMINI_API_KEY` from `.env`
- **Dev Dependencies:**
  - `typescript`, `tsx`, `@types/node`

### 3.2 CLI Argument Resolution (`FR-1`)
When a user runs `npm run diagnose --body-part-id right-foot-1`, npm strips `--body-part-id` and exposes the value as `process.env.npm_config_body_part_id` (or as a positional arg if npm consumes the flag as boolean). When run with `--` (`npm run diagnose -- --body-part-id right-foot-1`), it appears in `process.argv`.
The CLI parser will support all three seamlessly:
1. `--body-part-id <val>` or `--body-part-id=<val>` in `process.argv`
2. `process.env.npm_config_body_part_id` (if string and not `"true"`, else fallback to first positional argument in `process.argv`)
3. Optional `--force-transform` flag in case a user explicitly wants to rebuild the cache.

### 3.3 Transformation Cache Schema (`manifest.json`) (`FR-7`)
Stored at `reports/<body-part-id>/montages/manifest.json`:
```json
{
  "version": 1,
  "bodyPartId": "right-foot-1",
  "createdAt": "2026-10-18T20:00:00.000Z",
  "studyDescription": "RM PIE SIN CONTRASTE",
  "bodyPartExamined": "FOOT",
  "modalities": ["mri"],
  "mriSeries": [
    {
      "seriesNumber": 4,
      "seriesDescription": "t1_tse_sag_s2",
      "protocolName": "t1_tse_sag_s2",
      "sliceThickness": "3",
      "sliceCount": 28,
      "rows": 512,
      "cols": 512,
      "montageFile": "mri-series-4-t1_tse_sag_s2.png"
    }
  ],
  "xrayImages": []
}
```
**Cache Validation Logic:**
- Before scanning `data/<body-part-id>`, check if `reports/<body-part-id>/montages/manifest.json` exists.
- Parse JSON and verify every file listed in `mriSeries[].montageFile` and `xrayImages[].file` exists on disk and has size > 0.
- If valid, log `"Using cached transformed assets from reports/<body-part-id>/montages/"` and proceed directly to the Gemini step.

### 3.4 MRI & X-Ray Asset Discovery (`FR-2`, `FR-3`, `FR-4`)
- **Ignored Directories in `mri/`:** `weasis`, `Win32`, `x64`, `viewer-mac.app`, `licenses`, `settings`.
- **Ignored File Extensions/Names:** `.exe`, `.dll`, `.bat`, `.sh`, `.ini`, `.jar`, `.gz`, `.xz`, `.txt`, `.xml`, `.chm`, `.lic`, `.plist`, `.icns`, `.rsrc`, `.rtf`, `.scpt`, `.properties`, `.sample`, `DICOMDIR`.
- **DICOM Verification:** Check file size > 132 bytes and magic bytes `"DICM"` at offset `128..132`.
- **Modality Filter:**
  - In `mri/`: Keep only `Modality === "MR"` with valid `(7FE0,0010)` pixel data; discard `Modality === "SR"` (`PhoenixZIPReport`).
  - In `x-ray/`: Support standard image files (`.png`, `.jpg`, `.jpeg`, `.webp`) and DICOM files (`Modality === "CR" | "DX" | "RG"`).

### 3.5 DICOM Windowing & Montage Algorithm (`FR-5`, `FR-6`, `NFR-1`)
1. **PII Stripping:** Only read safe technical tags: `(0008,0060)` Modality, `(0008,1030)` StudyDescription, `(0008,103E)` SeriesDescription, `(0018,0015)` BodyPartExamined, `(0018,0050)` SliceThickness, `(0018,1030)` ProtocolName, `(0020,0011)` SeriesNumber, `(0020,0013)` InstanceNumber, `(0028,0004)` PhotometricInterpretation, `(0028,0010)` Rows, `(0028,0011)` Columns, `(0028,0100)` BitsAllocated, `(0028,0101)` BitsStored, `(0028,0103)` PixelRepresentation, `(0028,1050)` WindowCenter, `(0028,1051)` WindowWidth, `(0028,1052)` RescaleIntercept, `(0028,1053)` RescaleSlope. Never access `(0010,xxxx)` Patient tags.
2. **16-bit to 8-bit Windowing (VOI LUT):**
   - Apply `RescaleSlope` (default 1) and `RescaleIntercept` (default 0).
   - If `WindowCenter` ($WC$) and `WindowWidth` ($WW > 0$) are present:
     $$\text{lower} = WC - \frac{WW}{2}, \quad \text{upper} = WC + \frac{WW}{2}$$
     Map values $\le \text{lower} \to 0$, $\ge \text{upper} \to 255$, and linear interpolation in between.
   - However, some Siemens MRI files store small vendor-specific values in `WindowCenter`/`WindowWidth` that clip brighter tissue if used raw, so we also compute the 1st and 99.5th non-zero intensity percentiles of the slice; if the DICOM window clips >40% of non-background pixels to pure white/black, blend or fallback to the [1st, 99.5th] percentile window for optimal anatomical visibility.
   - Invert if `PhotometricInterpretation === "MONOCHROME1"`.
3. **Montage & High-Resolution Detail Panel Layout (Manifest v2):**
   - **Full-Series Overview Montage:** Sort slices in each series ascending by `InstanceNumber` and composite them at **100% native DICOM resolution** (no downscaling).
   - **High-Resolution Zoomed Detail Panels:** Group anatomical slices into 6-slice panels (`2x3` or `3x2`) upscaled with `Lanczos3` interpolation to at least `640px` per slice on the longest edge so Gemini's vision encoder (configured with `MediaResolution.MEDIA_RESOLUTION_HIGH`) captures fine trabecular, chondral, capsular, and pulley details.
   - **Edge Air-Slice Window Stabilization:** Clamp peripheral air-slice `WindowCenter`/`WindowWidth` outliers (`< 45%` of series median) to prevent thermal background static from blowing up on edge slices.

### 3.6 Gemini Multimodal Prompt & Report Generation (`FR-8`, `FR-9`)
- **Model:** Default to `gemini-2.5-flash` (or configurable via `GEMINI_MODEL` env var, e.g., `gemini-2.5-pro`).
- **Input Payload:**
  - System instruction framing Gemini as an expert musculoskeletal radiologist assistant.
  - Structured study summary (Body Part, Study Description, Modalities present, Table of MRI sequences & X-Ray projections).
  - Inline image parts (`inlineData` base64 `image/png`) for each MRI series montage and X-Ray image, interleaved with text labels identifying which sequence each image represents.
- **Output Report Structure (`reports/<body-part-id>/report.md`):**
  1. **Report Header & Study Metadata** (Case ID, Body Part, Study Description, Modalities, Sequences Analyzed)
  2. **Technical Quality & Sequences Overview**
  3. **Detailed Findings by Modality & Sequence** (Bones/Osseous structures, Joints & Cartilage, Tendons & Ligaments, Soft Tissues / Fluid / Edema, referencing specific sequences and slice numbers)
  4. **Diagnostic Impression & Differential Diagnosis**
  5. **Suggested Follow-up / Clinical Correlation**
  6. **Treatment & Surgical Considerations** (Conservative management, rehabilitation, injections, or whether surgical intervention is indicated)
  7. **Disclaimer** (AI-generated educational/research report, not a substitute for clinical diagnosis)

---

## 4. Phased Implementation Checklist

### Phase 1: Project Scaffolding & Configuration
- [x] **Task 1.1:** Initialize `package.json` with scripts (`"diagnose": "tsx src/index.ts"`, `"typecheck": "tsc --noEmit"`), install dependencies (`dicom-parser`, `sharp`, `@google/genai`, `dotenv`, `typescript`, `tsx`, `@types/node`).
- [x] **Task 1.2:** Create `tsconfig.json`, `.gitignore`, and `.env.example`.
- [x] **Task 1.3:** Implement `src/types.ts` and `src/config.ts` to parse `--body-part-id` (supporting both npm config env var and CLI flags) and environment variables.

### Phase 2: Asset Discovery & DICOM Windowing Engine
- [x] **Task 2.1:** Implement `src/scanner.ts` to discover `mri/` and `x-ray/` folders under `data/<body-part-id>`, filtering out bundled viewer folders (`weasis`, `Win32`, `x64`, `viewer-mac.app`, etc.) and non-DICOM files.
- [x] **Task 2.2:** Implement `src/dicom.ts` using `dicom-parser` to extract anonymized metadata, filter out `Modality = SR`, and perform 16-bit to 8-bit grayscale VOI LUT / percentile windowing.

### Phase 3: Montage Builder & Transformation Cache
- [x] **Task 3.1:** Implement `src/transformer.ts` using `sharp` to render slice tiles with slice-number overlays, assemble series grid montages with header banners, and process any `x-ray/` assets.
- [x] **Task 3.2:** Implement `src/cache.ts` to read/validate `reports/<body-part-id>/montages/manifest.json` and skip transformation when valid cached montages exist.
- [x] **Task 3.3:** Verify transformation and caching on `right-foot-1` and `right-hand-2` (confirming PNG montages and `manifest.json` are created on first run and reused on second run).

### Phase 4: Google Gemini Diagnostic Integration & Report Output
- [x] **Task 4.1:** Implement `src/gemini.ts` using `@google/genai` to construct the multimodal radiology prompt (interleaving sequence descriptions and montage PNGs) and request the diagnostic analysis.
- [x] **Task 4.2:** Implement `src/report.ts` and `src/index.ts` to orchestrate the full pipeline, write `reports/<body-part-id>/report.md`, and log clear progress to stdout.

### Phase 5: End-to-End Verification
- [x] **Task 5.1:** Run typechecking (`npm run typecheck`) and test CLI argument handling, cache hit/miss behavior, and report generation.
