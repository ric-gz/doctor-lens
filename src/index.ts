import { resolveCliConfig } from "./config.js";
import { loadValidCache } from "./cache.js";
import { scanCaseAssets } from "./scanner.js";
import { transformCaseAssets } from "./transformer.js";
import {
  generateDiagnosticReportWithGemini,
  generateReportSummaryWithGemini,
  translateMarkdownWithGemini,
} from "./gemini.js";
import { saveDiagnosticReport, saveMarkdownReportFile } from "./report.js";

async function main(): Promise<void> {
  const startTime = Date.now();
  const config = resolveCliConfig();

  console.log(`\n============================================================`);
  console.log(` Doctor Lens — Medical Imaging Diagnostic Pipeline`);
  console.log(` Case ID           : ${config.bodyPartId}`);
  console.log(` Source Folder     : ${config.dataDir}`);
  console.log(
    ` Clinical Notes    : ${
      config.clinicalNotes
        ? `Loaded (data/${config.bodyPartId}/clinical-notes.txt)`
        : "Not present"
    }`
  );
  console.log(` Output Folder     : ${config.reportDir}`);
  console.log(` Primary Model     : ${config.geminiModel}`);
  console.log(` Translation Model : ${config.geminiTranslationModel}`);
  console.log(` Target Language   : ${config.reportLang}`);
  console.log(`============================================================\n`);

  // Step 1: Check transformation cache first (FR-7)
  let manifest = !config.forceTransform
    ? loadValidCache(config.montagesDir, config.bodyPartId)
    : null;

  if (manifest) {
    const totalPanels = manifest.mriSeries.reduce(
      (acc, s) => acc + (s.panelFiles?.length ?? 0),
      0
    );
    const totalPairedPanels = (manifest.pairedMriSeries ?? []).reduce(
      (acc, p) => acc + (p.panelFiles?.length ?? 0),
      0
    );
    console.log(
      `[1/4] Cache Hit: Found existing transformed montages in reports/${config.bodyPartId}/montages/`
    );
    console.log(
      `      Skipping raw asset transformation (${manifest.mriSeries.length} full-res MRI montages + ${totalPanels} high-res ROI panels + ${totalPairedPanels} co-registered T1/FS paired panels, ${manifest.xrayImages.length} X-Ray images ready).`
    );
  } else {
    console.log(`[1/4] Scanning raw assets in data/${config.bodyPartId}...`);
    const discovered = scanCaseAssets(config.dataDir);
    console.log(
      `      Discovered: ${discovered.mriDicomFiles.length} MRI DICOM files, ${
        discovered.xrayImageFiles.length + discovered.xrayDicomFiles.length
      } X-Ray files.`
    );

    console.log(
      `      Transforming DICOM slices into 3D-ROI-cropped montages, CLAHE/sharpened high-res panels, and co-registered T1+FS paired panels...`
    );
    manifest = await transformCaseAssets(
      config.bodyPartId,
      discovered,
      config.montagesDir
    );
    const totalPanels = manifest.mriSeries.reduce(
      (acc, s) => acc + s.panelFiles.length,
      0
    );
    const totalPairedPanels = (manifest.pairedMriSeries ?? []).reduce(
      (acc, p) => acc + p.panelFiles.length,
      0
    );
    console.log(
      `      Generated ${manifest.mriSeries.length} MRI montage(s), ${totalPanels} high-res ROI panel(s), ${totalPairedPanels} co-registered T1/FS paired panel(s), and ${manifest.xrayImages.length} X-Ray image(s) in reports/${config.bodyPartId}/montages/`
    );
  }

  // Step 2: Generate original full diagnostic report (report.md)
  console.log(
    `[2/4] Requesting full diagnostic report from Google Gemini (${config.geminiModel})...`
  );
  const reportMarkdown = await generateDiagnosticReportWithGemini(
    manifest,
    config.montagesDir,
    config.geminiApiKey,
    config.geminiModel,
    config.clinicalNotes
  );

  const reportPath = saveDiagnosticReport(
    config.reportDir,
    manifest,
    reportMarkdown,
    config.geminiModel
  );
  console.log(`      Saved original report: ${reportPath}`);

  // Step 3: Only after the original report is generated, generate the executive summary (report-summary.md)
  console.log(
    `[3/4] Generating executive summary report (${config.geminiTranslationModel})...`
  );
  const summaryMarkdown = await generateReportSummaryWithGemini(
    reportMarkdown,
    config.geminiApiKey,
    config.geminiTranslationModel
  );

  const summaryPath = saveMarkdownReportFile(
    config.reportDir,
    "report-summary.md",
    manifest,
    summaryMarkdown,
    config.geminiTranslationModel,
    "en-US"
  );
  console.log(`      Saved summary report : ${summaryPath}`);

  // Step 4: Only after both original report and summary are completed, translate both to REPORT_LANG
  console.log(
    `[4/4] Translating report and summary to '${config.reportLang}' (${config.geminiTranslationModel})...`
  );
  const [translatedReportMarkdown, translatedSummaryMarkdown] =
    await Promise.all([
      translateMarkdownWithGemini(
        reportMarkdown,
        config.reportLang,
        config.geminiApiKey,
        config.geminiTranslationModel
      ),
      translateMarkdownWithGemini(
        summaryMarkdown,
        config.reportLang,
        config.geminiApiKey,
        config.geminiTranslationModel
      ),
    ]);

  const translatedReportPath = saveMarkdownReportFile(
    config.reportDir,
    `report-${config.reportLang}.md`,
    manifest,
    translatedReportMarkdown,
    config.geminiTranslationModel,
    config.reportLang
  );
  const translatedSummaryPath = saveMarkdownReportFile(
    config.reportDir,
    `report-summary-${config.reportLang}.md`,
    manifest,
    translatedSummaryMarkdown,
    config.geminiTranslationModel,
    config.reportLang
  );

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n------------------------------------------------------------`);
  console.log(` Original Report           : ${reportPath}`);
  console.log(` Executive Summary         : ${summaryPath}`);
  console.log(` Translated Report (${config.reportLang}) : ${translatedReportPath}`);
  console.log(` Translated Summary (${config.reportLang}): ${translatedSummaryPath}`);
  console.log(` Montages Directory        : ${config.montagesDir}`);
  console.log(` Completed in              : ${elapsedSec}s`);
  console.log(`------------------------------------------------------------\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n[Doctor Lens Error] ${message}\n`);
  process.exit(1);
});
