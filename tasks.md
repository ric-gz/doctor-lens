# Actionable Tasks — Doctor Lens (SDD - Stage 3)

Status Legend: `[ ]` Pending | `[~]` In Progress | `[x]` Completed

---

## Epic 1: Project Setup & Environment Configuration

- [x] **TASK-01: Initialize Node.js Project & Dependencies**
  - **Files:** `package.json`
  - **Action:** Create `package.json` (`type: "module"`), configure scripts (`"diagnose": "tsx src/index.ts"`, `"typecheck": "tsc --noEmit"`), and install dependencies (`dicom-parser`, `sharp`, `@google/genai`, `dotenv`) and devDependencies (`typescript`, `tsx`, `@types/node`).
  - **Acceptance Criteria:** `node_modules/` is installed cleanly and `npm run` lists `diagnose` and `typecheck`.

- [x] **TASK-02: Configure TypeScript, Git Ignore & Environment Template**
  - **Files:** `tsconfig.json`, `.gitignore`, `.env.example`
  - **Action:**
    - Configure strict TypeScript settings in `tsconfig.json` targeting Node LTS (`ES2022` / `NodeNext`).
    - Add `node_modules/`, `dist/`, `.env` to `.gitignore`.
    - Create `.env.example` documenting `GEMINI_API_KEY` and `GEMINI_MODEL=gemini-2.5-flash`.
  - **Acceptance Criteria:** `npm run typecheck` runs without configuration errors.

- [x] **TASK-03: Define Shared TypeScript Interfaces & Domain Types**
  - **Files:** `src/types.ts`
  - **Action:** Define data structures for `CliConfig`, `DiscoveredAssets`, `DicomSlice`, `MriSeriesGroup`, `MriSeriesMetadata`, `XrayAssetMetadata`, and `TransformationManifest`.
  - **Acceptance Criteria:** Types compile cleanly and cover all pipeline inputs/outputs.

- [x] **TASK-04: Implement CLI Argument & Environment Parser**
  - **Files:** `src/config.ts`
  - **Action:**
    - Load `.env` via `dotenv`.
    - Resolve `--body-part-id` whether invoked via `npm run diagnose --body-part-id right-foot-1` (`process.env.npm_config_body_part_id` + fallback positional arg) or `npm run diagnose -- --body-part-id right-foot-1` (`process.argv`).
    - Support optional `--force-transform` flag.
    - Validate that `data/<body-part-id>` exists on disk and throw a clear user-facing error if missing.
  - **Acceptance Criteria:** Both CLI invocation styles resolve `bodyPartId: "right-foot-1"` accurately.

---

## Epic 2: Transformation Cache Management (`FR-7`)

- [x] **TASK-05: Implement Manifest Cache Reader, Validator & Writer**
  - **Files:** `src/cache.ts`
  - **Action:**
    - Implement `loadValidCache(montagesDir, bodyPartId)`: checks if `reports/<body-part-id>/montages/manifest.json` exists, parses it, and verifies that every listed `montageFile` and `xrayImages[].file` exists on disk with size > 0 bytes.
    - Implement `saveCacheManifest(montagesDir, manifest)`: writes formatted `manifest.json` after transformation completes.
  - **Acceptance Criteria:** Returns the parsed `TransformationManifest` when valid files exist, or `null` if missing/incomplete.

---

## Epic 3: Asset Discovery & DICOM Parsing Engine (`FR-2` – `FR-5`, `NFR-1`)

- [x] **TASK-06: Implement Modality & File Scanner**
  - **Files:** `src/scanner.ts`
  - **Action:**
    - Check `data/<body-part-id>` for `mri/` and/or `x-ray/` subfolders (fail with clear error if neither exists).
    - Recursively scan `mri/` while skipping excluded viewer directories (`weasis`, `Win32`, `x64`, `viewer-mac.app`, `licenses`, `settings`) and non-DICOM files (`DICOMDIR`, `.exe`, `.bat`, `.sh`, `.ini`, `.jar`, `.txt`, `.xml`, etc.).
    - Verify DICOM Part 10 magic header (`"DICM"` at byte offset `128..132`).
    - Scan `x-ray/` (if present) for standard images (`.png`, `.jpg`, `.jpeg`, `.webp`) and DICOM files.
  - **Acceptance Criteria:** Correctly discovers all 169 DICOM files in `right-foot-1` and 198 DICOM files in `right-hand-2` while ignoring all viewer files.

- [x] **TASK-07: Implement DICOM Anonymized Parser & 16-bit to 8-bit Windowing**
  - **Files:** `src/dicom.ts`
  - **Action:**
    - Parse DICOM buffers using `dicom-parser`.
    - Read only safe technical/clinical tags (`Modality`, `StudyDescription`, `SeriesDescription`, `BodyPartExamined`, `ProtocolName`, `SliceThickness`, `SeriesNumber`, `InstanceNumber`, `Rows`, `Columns`, `BitsAllocated`, `BitsStored`, `PixelRepresentation`, `PhotometricInterpretation`, `WindowCenter`, `WindowWidth`, `RescaleSlope`, `RescaleIntercept`). Never read `(0010,xxxx)` PII tags.
    - Filter out non-image series (`Modality === "SR"` / `PhoenixZIPReport` or missing `(7FE0,0010)` PixelData).
    - Convert 16-bit pixel data to 8-bit grayscale (`Uint8Array`) using per-slice VOI LUT (`WindowCenter`/`WindowWidth`) with percentile contrast fallback.
    - Group MRI slices by `SeriesNumber` and sort slices within each series ascending by `InstanceNumber`.
  - **Acceptance Criteria:** Produces 6 grouped MR image series for `right-foot-1` (160 slices) and 6 grouped MR image series for `right-hand-2` (186 slices) with well-contrasted 8-bit pixel buffers and zero PII.

---

## Epic 4: Image Montage & X-Ray Transformation (`FR-6`)

- [x] **TASK-08: Implement MRI Series Grid Montage Generator & X-Ray Normalizer**
  - **Files:** `src/transformer.ts`
  - **Action:**
    - For each MRI series, resize each slice into a uniform tile (preserving aspect ratio) and overlay a crisp SVG slice label (`#1`, `#2`, etc.) in the top-left corner.
    - Calculate optimal grid dimensions (`cols x rows`) and composite all slices of a series into a single high-resolution PNG with a top header bar (`Series <num>: <SeriesDescription> | <sliceCount> slices | Thickness: <SliceThickness>mm`).
    - Save each series montage to `reports/<body-part-id>/montages/mri-series-<num>-<sanitizedDesc>.png`.
    - Convert/normalize any `x-ray/` images (standard images or DICOM `CR`/`DX`) into PNGs under `reports/<body-part-id>/montages/xray-<index>-<name>.png`.
    - Write `reports/<body-part-id>/montages/manifest.json` via `saveCacheManifest`.
  - **Acceptance Criteria:** Generates 6 labeled PNG montages + `manifest.json` for `right-foot-1` and `right-hand-2` in ~1.5 seconds per study.

---

## Epic 5: Google Gemini Integration & Report Output (`FR-8`, `FR-9`)

- [x] **TASK-09: Implement Google Gemini Multimodal Radiology Analyzer**
  - **Files:** `src/gemini.ts`
  - **Action:**
    - Initialize `@google/genai` `GoogleGenAI` client with `GEMINI_API_KEY`.
    - Build a structured musculoskeletal radiology prompt including study metadata (`bodyPartId`, `studyDescription`, `bodyPartExamined`, sequence list).
    - Attach each series montage PNG and X-Ray PNG as `inlineData` (`image/png`) paired with its sequence description label.
    - Request a structured Markdown diagnostic report (Study Summary, Sequences Analyzed, Findings per Structure/Sequence referencing slice numbers, Diagnostic Impression & Differential Diagnosis, Recommendations, and Medical Disclaimer).
  - **Acceptance Criteria:** Sends all series montages + metadata in a single multimodal Gemini call and returns the Markdown report text.

- [x] **TASK-10: Implement Report Writer & CLI Pipeline Orchestrator**
  - **Files:** `src/report.ts`, `src/index.ts`
  - **Action:**
    - Implement `saveDiagnosticReport(reportDir, manifest, markdown, modelName)` to write `reports/<body-part-id>/report.md`.
    - Wire the complete pipeline in `src/index.ts`:
      1. Parse CLI config (`--body-part-id`).
      2. Check transformation cache in `reports/<body-part-id>/montages/manifest.json` (skip transformation if cached and not `--force-transform`).
      3. Otherwise scan `data/<body-part-id>`, parse DICOMs, generate PNG montages, and save `manifest.json`.
      4. Call Google Gemini to generate the diagnosis report and save to `reports/<body-part-id>/report.md`.
  - **Acceptance Criteria:** Running `npm run diagnose --body-part-id right-foot-1` executes end-to-end, reuses cached montages on subsequent runs, and writes `reports/right-foot-1/report.md` when `GEMINI_API_KEY` is provided.

---

## Epic 6: Verification & Quality Assurance

- [x] **TASK-11: Verify Asset Transformation, Caching & CLI Execution**
  - **Files:** `reports/right-foot-1/montages/*`, `reports/right-hand-2/montages/*`
  - **Action:**
    - Ran `npm run typecheck` (passed with 0 errors).
    - Tested transformation and cache creation on both `right-foot-1` (169 DICOMs -> 6 MR series montages + 28 high-res detail panels) and `right-hand-2` (198 DICOMs -> 6 MR series montages + 34 high-res detail panels).
    - Verified second run immediately hits the cache (`manifest.json`) without re-transforming source files.
  - **Acceptance Criteria:** All checks passed.

- [x] **TASK-12: Implement Sequential Executive Summary (`report-summary.md`) & Multi-Language Translations (`report-[lang].md`, `report-summary-[lang].md`)**
  - **Files:** `.env.example`, `src/types.ts`, `src/config.ts`, `src/gemini.ts`, `src/report.ts`, `src/index.ts`
  - **Action:**
    - Added `GEMINI_TRANSLATION_MODEL` (default `gemini-flash-lite-latest`) and `REPORT_LANG` (default `es-ES`).
    - Generated `report-summary.md` only after `report.md` completes.
    - Generated `report-<lang-code>.md` and `report-summary-<lang-code>.md` only after both original files complete.
  - **Acceptance Criteria:** Verified all 4 report files generated for both `right-foot-1` and `right-hand-2`.
