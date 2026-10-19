import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, MediaResolution, type Part } from "@google/genai";
import type { TransformationManifest } from "./types.js";

const SYSTEM_INSTRUCTION = `You are an expert musculoskeletal radiologist assistant.
You are presented with medical imaging assets (MRI series overview montages, high-resolution ROI-cropped zoomed detail panels, co-registered side-by-side T1 + fluid-sensitive comparison panels, and/or X-Ray radiographs) along with anonymized DICOM technical metadata and, when present, optional patient clinical notes or symptom history (\`clinical-notes.txt\`).
For each MRI sequence (e.g., T1-weighted, Proton Density Fat-Suppressed / PD FS) and anatomical plane (Sagittal, Coronal, Axial/Transverse), you are provided with:
1. A 3D-ROI-Cropped Full Overview Montage showing the spatial progression of all sequential slices (#1, #2, ...) with slice locations in millimeters (e.g., \`+12.4mm\`) and calibrated millimeter scale bars (\`10 mm\` or \`5 mm\` with a midpoint tick) in the bottom-right of each tile.
2. High-Resolution ROI Detail Panels (6 zoomed, CLAHE-enhanced, edge-sharpened slices per panel) so you can inspect subtle trabecular, chondral, tendon, pulley, and ligament details without downscaling artifacts.
3. Co-Registered Side-by-Side T1 + Fluid-Sensitive (PD-FS / T2-FS) Panels placing spatially matched slices at the exact same anatomical level (\`SliceLocation\`) side-by-side so you can directly compare T1 marrow/anatomy against fluid-sensitive signal.

Use the calibrated millimeter scale bars (\`10 mm\` / \`5 mm\`) burned onto each slice tile to provide accurate quantitative measurements (in mm) for any cysts, joint effusions, tendon/sheath thickening, chondral defects, or diastasis. Analyze all provided sequences, high-resolution detail panels, and co-registered side-by-side panels thoroughly and systematically across every anatomical compartment. Do not omit secondary or subtle abnormalities discovered in the high-resolution panels. If patient clinical history or symptom notes (\`clinical-notes.txt\`) are provided, directly correlate your imaging evaluation with the patient's reported symptomatic site(s), clinical history, or point-of-pain coordinates—explicitly confirming or excluding pathology at the symptomatic site—while still performing a complete, unbiased evaluation across all other visualized anatomical compartments.

Produce a comprehensive, well-structured Markdown diagnostic report written entirely in standard English (do not use non-Latin scripts or foreign words) containing the following sections:
1. **Study Summary & Clinical Context** (Case ID, Body Part Examined, Study Description, Modalities & Sequences Analyzed, and Patient Clinical Notes / Symptoms if provided)
2. **Technical Quality & Sequences Overview** (Brief summary of the sequences/projections evaluated)
3. **Detailed Radiological Findings**
   - **Osseous Structures & Bone Marrow** (Systematic evaluation of cortical margins, trabecular signal intensity on T1 vs. fluid-sensitive sequences, subchondral bone, and alignment across all visualized bones, referencing exact Series and Slice #s)
   - **Articular Spaces & Cartilage** (Joint spaces, articular cartilage, joint recesses, and capsular margins across all visualized joints, referencing exact Series and Slice #s)
   - **Tendons & Ligaments** (Flexor/extensor tendons and sheaths, collateral/interosseous ligaments, plantar/volar plates, pulleys, and aponeuroses/retinacula as applicable, referencing exact Series and Slice #s)
   - **Soft Tissues & Neurovascular Bundles** (Subcutaneous tissues, fat pads, interdigital/intermetatarsal/intermetacarpal spaces, neurovascular bundles, and intrinsic musculature, referencing exact Series and Slice #s)
4. **Diagnostic Impression & Differential Diagnosis** (Numbered conclusions ordered by clinical significance, ensuring every abnormal finding identified in Section 3 is represented and directly correlated with the patient's reported symptoms when clinical notes are provided)
5. **Suggested Follow-up / Clinical Correlation**
6. **Treatment & Surgical Considerations** (Evaluate whether conservative management, physical therapy, orthotics/splinting, image-guided injections, or surgical intervention is recommended or needed based on the severity of the imaging findings, outlining specific non-operative vs. operative indications)
7. **Disclaimer** (Explicitly state that this report is AI-generated for educational and research assistance only and must be reviewed and verified by a licensed physician/radiologist).`;

/**
 * Sends all transformed MRI series overview montages, high-resolution detail panels,
 * and X-Ray images along with structured study metadata and optional clinical notes
 * to Google Gemini using MEDIA_RESOLUTION_HIGH and returns the Markdown diagnostic report.
 */
export async function generateDiagnosticReportWithGemini(
  manifest: TransformationManifest,
  montagesDir: string,
  apiKey: string | undefined,
  modelName: string,
  clinicalNotes?: string
): Promise<string> {
  if (!apiKey) {
    throw new Error(
      "Missing GEMINI_API_KEY. Please set GEMINI_API_KEY in your environment or .env file.\n" +
        "Note: Asset transformation and caching in reports/" +
        manifest.bodyPartId +
        "/montages/ succeeded and will be reused on your next run."
    );
  }

  const ai = new GoogleGenAI({ apiKey });

  const contents: Part[] = [];

  const introLines: string[] = [
    `# Imaging Study Input for Case: ${manifest.bodyPartId}`,
    `- **Study Description:** ${manifest.studyDescription}`,
    `- **Body Part Examined:** ${manifest.bodyPartExamined}`,
    `- **Modalities Present:** ${manifest.modalities.join(", ").toUpperCase()}`,
    "",
  ];

  if (clinicalNotes) {
    introLines.push(
      "## Patient Clinical Notes & Symptoms (`clinical-notes.txt`):",
      clinicalNotes,
      "",
      "Please correlate the imaging findings directly with the patient's clinical history and symptomatic site(s) described above, while still evaluating all anatomical structures systematically.",
      ""
    );
  }

  if (manifest.mriSeries.length > 0) {
    introLines.push("## MRI Series Included:");
    for (const s of manifest.mriSeries) {
      const cropInfo =
        s.croppedCols && s.croppedRows
          ? `, ROI Cropped ${s.croppedCols}x${s.croppedRows}`
          : "";
      const spacingInfo = s.pixelSpacingMm
        ? `, Pixel Spacing ${s.pixelSpacingMm[0].toFixed(3)}x${s.pixelSpacingMm[1].toFixed(3)}mm`
        : "";
      introLines.push(
        `- **Series ${s.seriesNumber} (${s.seriesDescription}):** ${s.sliceCount} slices, Thickness ${s.sliceThickness}mm, Native ${s.cols}x${s.rows}${cropInfo}${spacingInfo} (Overview: \`${s.montageFile}\` + ${s.panelFiles.length} High-Res Detail Panels)`
      );
    }
    introLines.push("");
  }

  if (manifest.pairedMriSeries && manifest.pairedMriSeries.length > 0) {
    introLines.push("## Co-Registered T1 + Fluid-Sensitive Side-by-Side Series Pairs:");
    for (const p of manifest.pairedMriSeries) {
      introLines.push(
        `- **${p.plane.toUpperCase()} Co-Registered Pair:** Series ${p.t1SeriesNumber} (\`${p.t1SeriesDescription}\` [T1]) ⇄ Series ${p.fluidSeriesNumber} (\`${p.fluidSeriesDescription}\` [Fluid-Sensitive]) — ${p.pairCount} matched slice pairs across ${p.panelFiles.length} side-by-side panels`
      );
    }
    introLines.push("");
  }

  if (manifest.xrayImages.length > 0) {
    introLines.push("## X-Ray Radiographs Included:");
    for (const x of manifest.xrayImages) {
      introLines.push(
        `- **${x.file}** (Original: \`${x.originalName}\`, ${x.width}x${x.height}${
          x.seriesDescription ? `, ${x.seriesDescription}` : ""
        })`
      );
    }
    introLines.push("");
  }

  introLines.push(
    "Below are the full-resolution overview montages, high-resolution zoomed detail panels for every series, and radiographs. Please examine all slices carefully and generate the diagnostic report."
  );

  contents.push({ text: introLines.join("\n") });

  // Attach each MRI series overview montage followed by its high-resolution zoomed panels
  for (const series of manifest.mriSeries) {
    const overviewPath = path.join(montagesDir, series.montageFile);
    const overviewBuf = fs.readFileSync(overviewPath);
    contents.push({
      text: `### MRI Series ${series.seriesNumber}: ${series.seriesDescription} — Full Sequence Overview (${series.sliceCount} slices, Slice Thickness: ${series.sliceThickness}mm)`,
    });
    contents.push({
      inlineData: {
        mimeType: "image/png",
        data: overviewBuf.toString("base64"),
      },
    });

    for (let idx = 0; idx < series.panelFiles.length; idx++) {
      const panelFile = series.panelFiles[idx];
      const panelPath = path.join(montagesDir, panelFile);
      const panelBuf = fs.readFileSync(panelPath);
      contents.push({
        text: `#### MRI Series ${series.seriesNumber} (${series.seriesDescription}) — High-Resolution Zoomed Panel ${idx + 1} of ${series.panelFiles.length}`,
      });
      contents.push({
        inlineData: {
          mimeType: "image/png",
          data: panelBuf.toString("base64"),
        },
      });
    }
  }

  // Attach Co-Registered Side-by-Side T1 + Fluid-Sensitive panels
  for (const paired of manifest.pairedMriSeries ?? []) {
    for (let idx = 0; idx < paired.panelFiles.length; idx++) {
      const panelFile = paired.panelFiles[idx];
      const panelPath = path.join(montagesDir, panelFile);
      const panelBuf = fs.readFileSync(panelPath);
      contents.push({
        text: `### Co-Registered ${paired.plane.toUpperCase()} Side-by-Side Comparison: Series ${paired.t1SeriesNumber} (${paired.t1SeriesDescription} [T1]) vs Series ${paired.fluidSeriesNumber} (${paired.fluidSeriesDescription} [FS]) — Panel ${idx + 1} of ${paired.panelFiles.length}`,
      });
      contents.push({
        inlineData: {
          mimeType: "image/png",
          data: panelBuf.toString("base64"),
        },
      });
    }
  }

  // Attach each X-Ray PNG interleaved with its description
  for (const xray of manifest.xrayImages) {
    const filePath = path.join(montagesDir, xray.file);
    const imgBuf = fs.readFileSync(filePath);
    contents.push({
      text: `### X-Ray Image: ${xray.file} (${xray.originalName})`,
    });
    contents.push({
      inlineData: {
        mimeType: "image/png",
        data: imgBuf.toString("base64"),
      },
    });
  }

  const response = await ai.models.generateContent({
    model: modelName,
    contents,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0,
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
    },
  });

  const reportText = response.text?.trim();
  if (!reportText) {
    throw new Error("Google Gemini returned an empty response.");
  }

  return reportText;
}

const SUMMARY_SYSTEM_INSTRUCTION = `You are a concise medical report summarizer.
Given a complete musculoskeletal MRI/X-Ray diagnostic report in Markdown, generate an executive summary in standard English Markdown with the following exact sections:
1. **Case Overview** (1-2 lines stating the Case ID, Body Part Examined, Study Description, and any provided Patient Clinical Context / Symptoms)
2. **Key Radiological Findings (Summary)** (A bulleted list where every distinct finding from Section 3 and Section 4 of the report is condensed into 1–2 clear, high-yield lines, preserving key Series/Slice references)
3. **Findings in Plain Language (Easy to Understand)** (A bulleted list containing ONLY bullet points—no introductory or concluding text—explaining each relevant finding in very simple, everyday language without complex medical jargon)
4. **Treatment & Surgical Considerations Summary**
   - **Conservative / Non-Operative Management:** 1–2 concise lines summarizing the recommended first-line non-operative care, orthotics/splinting, therapy, or image-guided interventions.
   - **Operative / Surgical Considerations:** 1–2 concise lines stating clearly whether surgery is needed/indicated and under what conditions surgical options would be considered.
5. **Disclaimer** (1-line AI-generated medical disclaimer).`;

/**
 * Generates a short executive summary (`report-summary.md`) from the already-generated
 * full diagnostic report.
 */
export async function generateReportSummaryWithGemini(
  fullReportMarkdown: string,
  apiKey: string | undefined,
  modelName: string
): Promise<string> {
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: modelName,
    contents: [
      {
        text: `Summarize the following diagnostic report according to your instructions:\n\n${fullReportMarkdown}`,
      },
    ],
    config: {
      systemInstruction: SUMMARY_SYSTEM_INSTRUCTION,
      temperature: 0,
    },
  });

  const summaryText = response.text?.trim();
  if (!summaryText) {
    throw new Error("Google Gemini returned an empty summary response.");
  }

  return summaryText;
}

/**
 * Translates a Markdown medical report or summary into the specified target language code
 * (e.g., `es-ES`) using the configured cheaper translation model while preserving all
 * Markdown formatting, structure, and Series/Slice references.
 */
export async function translateMarkdownWithGemini(
  markdownContent: string,
  targetLangCode: string,
  apiKey: string | undefined,
  translationModelName: string
): Promise<string> {
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const systemInstruction = `You are a professional medical translator specializing in musculoskeletal radiology.
Translate the provided Markdown document accurately and naturally into the target language locale "${targetLangCode}".
Rules:
- Preserve all Markdown headings, bold/italic formatting, bullet points, and structure exactly.
- Preserve the tone and register of each section: keep clinical sections medically precise, and keep plain-language / easy-to-understand sections in simple, everyday language free of complex medical jargon.
- Preserve technical identifiers such as Case IDs (e.g., \`right-foot-1\`), DICOM sequence codes (e.g., \`pd_tse_fs_sag\`, \`Series 5\`), and slice numbers.
- Do not add any conversational preamble or postscript; output ONLY the translated Markdown content.`;

  const response = await ai.models.generateContent({
    model: translationModelName,
    contents: [
      {
        text: markdownContent,
      },
    ],
    config: {
      systemInstruction,
      temperature: 0,
    },
  });

  const translatedText = response.text?.trim();
  if (!translatedText) {
    throw new Error(
      `Google Gemini returned an empty translation response for language '${targetLangCode}'.`
    );
  }

  return translatedText;
}
