# Requirements Document (SDD - Stage 1)

## 1. Project Overview
**Doctor Lens** is a Node.js/TypeScript CLI application that analyzes medical imaging assets (MRI and X-Ray) for a specified body-part case ID (`<body-part>-<id>`), transforms the raw medical imaging data into LLM-compatible visual montages and anonymized metadata, and sends them to **Google Gemini** to generate a structured diagnostic report.

---

## 2. Data Exploration & Asset Analysis Findings

### 2.1 Folder Structure (`data/`)
Each study case resides under `data/<body-part>-<id>/` (e.g., `data/right-foot-1`, `data/right-hand-2`).
Inside each case directory:
- At least one modality subfolder is present: `mri/` and/or `x-ray/`.
- Currently available datasets:
  - `data/right-foot-1/mri/`
  - `data/right-hand-2/mri/`

### 2.2 MRI Folder Anatomy (`mri/`)
The `mri/` directories are full CD/DVD distribution packages exported from a Siemens MRI system, bundled with standalone DICOM viewers:
- **Bundled Viewers & Non-Medical Files (to be ignored):**
  - `Win32/`, `x64/` (MicroDicom Windows executables `mDicom.exe`)
  - `weasis/`, `viewer-mac.app/`, `viewer-linux.sh`, `viewer-win32.exe`, `ArrancaVisorDicom.bat` (Weasis Java portable DICOM viewer)
  - `licenses/`, `settings/`, `readme.txt`, `Leeme.txt`, `tree.txt`
- **Index & Medical Assets:**
  - `DICOMDIR`: Standard DICOM Media Storage Directory index file at the root of `mri/`.
  - `1/<series>/<instance>`: Extensionless DICOM Part 10 files (`DICM` magic prefix at byte offset 128, Transfer Syntax `1.2.840.10008.1.2.1` - Explicit VR Little Endian).

### 2.3 MRI Series Breakdown in Current Datasets
1. **Non-Image Series (`Modality = SR`, `SeriesDescription = PhoenixZIPReport`):**
   - `1/1/*` in both studies contains Siemens protocol/Phoenix Structured Report (`SR`) files (SOP Class `1.2.840.10008.5.1.4.1.1.88.22`) with no pixel data. These must be excluded from image rendering.
2. **Diagnostic MR Image Series (`Modality = MR`):**
   - Uncompressed 16-bit (`bitsAllocated: 16`, `bitsStored: 12`), `MONOCHROME2` grayscale pixel data (`(7FE0,0010)`), with explicit `WindowCenter` (`(0028,1050)`) and `WindowWidth` (`(0028,1051)`) tags.
   - **`right-foot-1` (`RM PIE SIN CONTRASTE`, 6 MR series, 160 total slices):**
     - Series 2: `t1_tse_sag_s2` (28 slices, 512x512, Sagittal T1)
     - Series 3: `pd_tse_fs_sag` (28 slices, 448x448, Sagittal PD Fat-Sat)
     - Series 4: `pd_tse_cor_fs` (22 slices, 544x464, Coronal PD Fat-Sat)
     - Series 5: `t1_tse_cor` (22 slices, 608x512, Coronal T1)
     - Series 6: `pd_tse_fs_tra` (30 slices, 320x320, Transverse/Axial PD Fat-Sat)
     - Series 7: `t1_tse_tra` (30 slices, 480x512, Transverse/Axial T1)
   - **`right-hand-2` (`RM MANO SIN CONTRASTE`, 6 MR series, 186 total slices):**
     - Series 2: `pd_tse_fs_tra_s2` (40 slices, 416x144, Axial PD Fat-Sat)
     - Series 3: `t1_tse_tra_p2_s2` (40 slices, 216x416, Axial T1)
     - Series 4: `pd_tse_fs_sag_p2_s2` (38 slices, 512x192, Sagittal PD Fat-Sat)
     - Series 5: `pd_tse_fs_tra_s2` (40 slices, 132x416, Axial PD Fat-Sat)
     - Series 6: `pd_tse_fs_cor` (14 slices, 480x348, Coronal PD Fat-Sat Wrist)
     - Series 7: `t1_tse_cor_s2` (14 slices, 704x480, Coronal T1 Hand)

### 2.4 X-Ray Folder Anatomy (`x-ray/`)
- Each case folder may also contain an `x-ray/` directory (either standalone or alongside `mri/`).
- Can contain standard image files (`.png`, `.jpg`, `.jpeg`, `.webp`) or DICOM X-Ray files (`Modality = CR` or `DX`, or extensionless/`.dcm` DICOM files).

---

## 3. Technical Approach & Libraries

### 3.1 Transformation Pipeline
1. **VOI LUT Windowing (16-bit to 8-bit):**
   - Apply DICOM `WindowCenter` (`(0028,1050)`) and `WindowWidth` (`(0028,1051)`) (with fallback to percentile min/max normalization) to convert 12-bit/16-bit `MONOCHROME2` grayscale pixel values into high-contrast 8-bit (`0–255`) grayscale buffers.
2. **Series Tiled Montages (Contact Sheets) & Caching:**
   - Sort slices within each MR series by `InstanceNumber` (`(0020,0013)`).
   - Generate **1 composite PNG grid montage per MRI series** (saved under `reports/<body-part-id>/montages/`), preserving full sequence context across all 14–40 slices per series in 6 clean images per MRI study.
   - Normalize and copy/convert any `x-ray/` images into `reports/<body-part-id>/x-ray/` (or `montages/`).
   - **Idempotent Transformation Cache:** Persist a metadata manifest (e.g., `reports/<body-part-id>/montages/manifest.json`) alongside the transformed images. On subsequent CLI runs for the same `<body-part-id>`, check if the transformed montages and manifest already exist and reuse them directly without re-parsing or re-transforming the raw `data/` files.

### 3.2 Selected Libraries (Node.js / TypeScript)
- **`dicom-parser`** (CornerstoneJS): Zero-dependency DICOM Part 10 parser for extracting tags and raw 16-bit `(7FE0,0010)` pixel buffers while stripping patient PII (`0010,xxxx`).
- **`sharp`**: High-performance image processor to encode 8-bit raw pixel buffers into PNG slices and composite them into series montages.
- **`@google/genai`** (Google Gen AI SDK): Official Google Gemini SDK to send multimodal requests (series montage PNGs + X-Ray images + structured metadata prompt) and receive the diagnostic report.

---

## 4. User Stories

- **US-1 (Single-Command Execution):**
  *As a user*, I want to run `npm run diagnose --body-part-id <body-part>-<id>` (or `npm run diagnose -- --body-part-id <body-part>-<id>`) so that the system automatically locates the case in `data/<body-part>-<id>`, processes all available imaging modalities, and produces a diagnostic report.
- **US-2 (Automatic Modality & Asset Discovery):**
  *As a user*, I want the app to automatically scan `data/<body-part>-<id>/` for `mri/` and/or `x-ray/` folders, ignore bundled DICOM viewer executables (`weasis/`, `Win32/`, `x64/`, `viewer-*`), and skip non-image DICOM files (`Modality = SR`), so only valid diagnostic images are processed.
- **US-3 (DICOM-to-Montage Transformation, Caching & Privacy):**
  *As a user*, I want 16-bit MRI/X-Ray DICOM slices to be accurately windowed to 8-bit PNG images, ordered by slice number, assembled into series montages under `reports/<body-part>-<id>/montages/`, and stripped of all patient PII tags before any external API call. If the transformation was already completed in a previous run, the app must reuse the existing transformed files instead of re-processing the source assets.
- **US-4 (Gemini Diagnostic Report Generation):**
  *As a user*, I want the generated montages, X-Ray images, and anonymized study metadata sent to Google Gemini with a structured radiology prompt, and the resulting report saved to `reports/<body-part>-<id>/report.md`.

---

## 5. Functional Requirements

| ID | Requirement | Description |
|----|-------------|-------------|
| **FR-1** | **CLI Input Argument** | Support `npm run diagnose --body-part-id <body-part-id>` (handling both npm's `npm_config_body_part_id` environment variable when invoked without `--` and CLI flag `--body-part-id <value>` when invoked with `--`). Validate that `data/<body-part-id>` exists. |
| **FR-2** | **Modality Detection** | Check for the presence of `mri/` and/or `x-ray/` subdirectories inside `data/<body-part-id>/`. Fail gracefully with a clear error message if neither exists or contains valid imaging assets. |
| **FR-3** | **MRI DICOM Discovery & Filtering** | Scan `mri/` (excluding viewer directories `weasis`, `Win32`, `x64`, `viewer-mac.app`, `licenses`, `settings`) to locate DICOM files. Filter for image modalities (`Modality === 'MR'`) and exclude Structured Reports (`Modality === 'SR'`). |
| **FR-4** | **X-Ray Asset Discovery** | Scan `x-ray/` (when present) for standard image files (`.png`, `.jpg`, `.jpeg`, `.webp`) and DICOM X-Ray files (`CR`, `DX`, `.dcm`, or extensionless DICOMs). |
| **FR-5** | **DICOM Parsing & Anonymization** | Extract technical/clinical metadata (`StudyDescription`, `SeriesDescription`, `SeriesNumber`, `InstanceNumber`, `SliceThickness`, `BodyPartExamined`, `Rows`, `Columns`, `WindowCenter`, `WindowWidth`) while stripping all patient PII (`0010,xxxx` tags and institution/physician names). |
| **FR-6** | **16-bit Windowing & Montage Generation** | Convert 16-bit `MONOCHROME2` pixel data to 8-bit grayscale using DICOM `WindowCenter`/`WindowWidth` (with auto-contrast fallback). Sort slices by `InstanceNumber`, composite each MRI series into a labeled grid PNG, and save to `reports/<body-part-id>/montages/` along with an anonymized metadata manifest (`manifest.json`). |
| **FR-7** | **Transformation Cache Check** | Before parsing or transforming source assets in `data/<body-part-id>`, check if `reports/<body-part-id>/montages/` already contains the generated montages and `manifest.json`. If present and valid, skip the transformation step and load the existing transformed images and metadata directly. |
| **FR-8** | **Google Gemini Integration** | Authenticate via `GEMINI_API_KEY` (from environment or `.env` file) using `@google/genai`. Send all generated series montages, X-Ray images, and structured sequence metadata with a comprehensive radiology prompt to a Gemini vision-capable model. |
| **FR-9** | **Diagnostic Report Output** | Save the generated Markdown diagnostic report to `reports/<body-part-id>/report.md` (including Study Summary, Technique/Sequences Analyzed, Findings by Modality/Series, Differential Diagnosis / Clinical Impression, Suggested Follow-up, Treatment & Surgical Considerations in `## 6`, and a Medical Disclaimer in `## 7`) and print a summary/path to the console. |
| **FR-10** | **Executive Summary Generation (`report-summary.md`)** | Only after `report.md` is generated, generate a concise executive summary (`reports/<body-part-id>/report-summary.md`) containing 1–2 lines per finding, an easy-to-understand plain-language findings section (bullet points only, without complex medical jargon), and a concise summary of Section `## 6` (Conservative vs. Operative considerations). |
| **FR-11** | **Multi-Language Report & Summary Translation** | Only after both `report.md` and `report-summary.md` are completed, translate both files into the target language configured by `REPORT_LANG` (default `es-ES`) using a cheaper translation model configured by `GEMINI_TRANSLATION_MODEL` (default `gemini-flash-lite-latest`), saving `reports/<body-part-id>/report-<lang-code>.md` and `reports/<body-part-id>/report-summary-<lang-code>.md`. |

---

## 6. Non-Functional Requirements

- **NFR-1 (Privacy by Design):** Zero patient-identifying DICOM tags (`0010,xxxx`) or institution/physician identifiers may be logged, written to transformed image overlays, or transmitted to Google Gemini.
- **NFR-2 (Read-Only Source Data):** The `data/` directory must remain strictly read-only; all generated artifacts (`montages/` and `report.md`) are written exclusively under `reports/<body-part-id>/`.
- **NFR-3 (Performance):** Parsing and transforming an entire MRI study (~160–190 DICOM slices) into PNG montages should complete locally in a few seconds using in-memory buffers (`dicom-parser` + `sharp`).
- **NFR-4 (Extensibility):** Support adding new `<body-part>-<id>` folders with `mri/` and/or `x-ray/` subfolders without code changes, and allow configuring the Gemini model name via environment variables (with a sensible default).
