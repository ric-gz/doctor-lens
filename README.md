# Doctor Lens

Medical imaging (MRI & X-Ray) processing and AI-assisted diagnostic report generator powered by Google Gemini.

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

### Optional Clinical Notes (`clinical-notes.txt`)

If a `clinical-notes.txt` file is present in the case folder (`data/<body-part-id>/clinical-notes.txt`), the pipeline automatically reads it and passes the clinical history / symptoms to the radiologist agent to correlate imaging findings directly with the patient's symptomatic site.

### Other Commands

- **Typechecking**:
  ```bash
  npm run typecheck
  ```
