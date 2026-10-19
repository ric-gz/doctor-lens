# AGENTS.md

Guidelines for AI agents working on Doctor Lens.

## Project Overview
Doctor Lens is a TypeScript/Node.js medical imaging (MRI & X-Ray) processing and AI-assisted diagnostic report generator using Google Gemini and `sharp`/`dicom-parser`.

## Core Commands
- **Run pipeline**: `npm run diagnose -- --body-part-id <case-id>` (e.g., `right-hand-2`)
- **Typecheck**: `npm run typecheck`

## Architecture & Key Files
- `src/index.ts`: Main CLI orchestration pipeline (4 steps: asset loading/caching, report generation, summary generation, translation).
- `src/config.ts`: CLI argument parsing & environment variable resolution.
- `src/scanner.ts`: Scans raw DICOM and X-Ray files from `data/<body-part-id>`.
- `src/transformer.ts`: Converts DICOM slices into optimized PNG montages and detail panels using `sharp`.
- `src/cache.ts`: Validates and loads transformation cache (`manifest.json`).
- `src/gemini.ts`: Interacts with Google Gemini API for image analysis and report generation.
- `src/report.ts`: Formats and saves markdown reports.

## Conventions
- Use TypeScript with ES modules (`"type": "module"` in `package.json`).
- Do not check in sensitive API keys (`GEMINI_API_KEY`).
- Never read or inspect the `.env` file or other secrets/environment files.
- Respect existing code style and structure.
