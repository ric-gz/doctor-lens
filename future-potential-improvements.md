# Future Potential Improvements — Doctor Lens

## 1. Image Transformation & Preprocessing

- [x] **Paired T1 + PD-FS Side-by-Side Co-Registered Panels (Implemented):**
  - Co-register matching anatomical slices (using DICOM `ImageOrientationPatient` `(0020,0037)`, `ImagePositionPatient` `(0020,0032)`, and `SliceLocation` `(0020,1041)`) and place the T1 slice and PD Fat-Suppressed slice side-by-side in the same image panel (`mri-paired-*.png`). This makes T1 vs. fluid-sensitive signal cross-referencing instantaneous for the Vision LLM.
- [x] **Multi-Window Rendering / CLAHE & Rician Noise-Floor Suppression (Implemented):**
  - Suppress background Rician air noise using corner-patch percentile estimation, stabilize windowing across the 3D series, and blend CLAHE (Contrast Limited Adaptive Histogram Equalization) + edge sharpening to highlight subtle trabecular, chondral, and ligamentous margins without clipping bright fluid or distorting true T1/PD-FS signal ratios.
- [x] **Automated ROI Cropping & Background Trimming (Implemented):**
  - Detect the 3D union bounding box of the anatomical structure across the series volume and crop out empty black air margins around the foot/hand before Lanczos3 upscaling (`768px` long edge), increasing effective anatomical pixel density by 40–100%+.
- [ ] **3D Spatial Cross-Reference Lines (Localizer Overlays):**
  - Use `ImageOrientationPatient` `(0020,0037)` and `ImagePositionPatient` `(0020,0032)` to draw faint reference lines on a sagittal/coronal key slice indicating the exact plane of each axial slice (`#1`–`#30`), eliminating any ambiguity about which ray or joint level a slice intersects.
- [x] **Quantitative Pixel-Spacing Scale Bars & Slice Location Overlays (Implemented):**
  - Read `PixelSpacing` `(0028,0030)` and `SliceLocation` `(0020,1041)` from the DICOM header and burn an accurate calibrated `10 mm` (or `5 mm`) scale bar with midpoint tick plus millimeter slice location onto each tile so the LLM can measure cyst, lesion, or diastasis dimensions directly instead of estimating.

---

## 2. Diagnostic Report Generation & LLM Pipeline

- **Multi-Agent / Two-Pass Verification Pipeline:**
  - **Pass 1 (Per-Plane Specialist Pass):** Dedicated calls for Sagittal, Coronal, and Axial planes to catalog every slice-level observation independently.
  - **Pass 2 (Critique & Cross-Plane Verification Pass):** A second pass that takes the candidate findings and re-verifies each cited `(Series, Slice #)` across orthogonal planes to eliminate false positives before writing the final report.
- **Anatomical Checklist Structured Output (JSON Schema -> Markdown):**
  - Enforce a strict JSON schema intermediate step covering every anatomical structure for that specific body part (e.g., each ray 1–5, each sesamoid, each TMT/MTP/IP joint, each tendon/pulley) before rendering `report.md`, ensuring zero compartments are ever skipped.
- **Annotated Key-Slice Visual Evidence in the Report:**
  - Have Gemini output bounding-box coordinates (`[ymin, xmin, ymax, xmax]`) for its top findings, crop/highlight those specific slices with `sharp`, and embed the annotated key-slice images directly inside `report.md` and `report-summary.md`.
- [x] **Clinical Context / Symptom Intake (`clinical-notes.txt`) (Implemented):**
  - Automatically reads `data/<body-part-id>/clinical-notes.txt` if present and passes the patient's clinical history or point-of-pain symptoms to the radiologist agent so it can correlate imaging findings directly with the symptomatic site.
