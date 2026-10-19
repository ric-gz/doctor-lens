# Doctor Lens

Medical imaging (MRI & X-Ray) processing and AI-assisted diagnostic report generator powered by Google Gemini.

> **Note**: Doctor Lens is a vibe coded project.

## Features

- **DICOM Processing**: Scans and parses medical imaging files, converting them into optimized visual formats (PNG montages and panels) using `sharp` and `dicom-parser`.
- **AI-Powered Diagnostics**: Automatically analyzes medical scans using Google Gemini multimodal capabilities to generate structured radiological findings, impressions, and recommendations.
- **Multilingual Reports**: Generates professional clinical reports in multiple languages (e.g., English and Spanish).
- **Caching**: Avoids redundant API calls and processing with local report caching.

## Prerequisites

- Node.js (v18+ recommended)
- Google Gemini API Key (`GEMINI_API_KEY` environment variable)

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the root directory. Required and optional environment variables:

```env
# Required
GEMINI_API_KEY=your_gemini_api_key_here

# Optional (defaults shown)
GEMINI_MODEL=gemini-4-argon
GEMINI_TRANSLATION_MODEL=gemini-flash-lite-latest
REPORT_LANG=es-ES
```

## Data Directory Setup

Because medical imaging files contain sensitive patient data, the `data/` directory is git-ignored and must be created manually in the project root before running the pipeline.

Each case lives in its own folder under `data/<body-part-id>/` (where `<body-part-id>` is the identifier passed to `--body-part-id`):

```text
data/
└── <body-part-id>/           # e.g., right-hand-2, right-foot-1
    ├── mri/                  # Raw MRI DICOM files (nested CD/export folders supported)
    ├── x-ray/                # X-Ray DICOM files or images (.png, .jpg, .jpeg, .webp)
    └── clinical-notes.txt    # Optional patient symptoms / clinical history
```

### Folder Requirements

- **At least one modality folder (`mri/` or `x-ray/`) is required** inside `data/<body-part-id>/`:
  - **`mri/`**: Place raw DICOM Part 10 files here. Files can be nested in subfolders (such as raw hospital CD exports); the scanner traverses directories recursively and automatically ignores `DICOMDIR` index files and bundled viewer executables (`weasis`, `win32`, `x64`, `viewer-mac.app`, etc.).
  - **`x-ray/`**: Place X-Ray studies here. Both raw DICOM Part 10 files and standard image files (`.png`, `.jpg`, `.jpeg`, `.webp`) are supported and scanned recursively.
- **`clinical-notes.txt` *(Optional)***: If present in `data/<body-part-id>/clinical-notes.txt`, the pipeline reads the text and supplies the clinical history/symptoms to the radiologist agent so imaging findings are correlated with the patient's symptomatic site.

## Usage & Commands

### Running a Diagnosis

To process and diagnose a medical case, pass the target body part / case identifier using `--body-part-id` (or `-b`):

```bash
npm run diagnose -- --body-part-id right-hand-2
```

Or via npm configuration format:

```bash
npm run diagnose --body-part-id right-hand-2
```

### Available Flags & Options

- `--body-part-id <id>`, `-b <id>` *(Required)*: Specifies the case/folder name located inside the `data/` directory (e.g., `right-hand-2`).
- `--force-transform`, `-f` *(Optional)*: Forces re-processing and re-conversion of DICOM images even if existing montages are already cached.

### Other Commands

- **Typechecking**:
  ```bash
  npm run typecheck
  ```

## Disclaimer

*This project and any AI-generated outputs are for educational and informational purposes only and must be reviewed and verified by a licensed healthcare professional before making any clinical or treatment decisions.*
