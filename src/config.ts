import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { CliConfig } from "./types.js";

dotenv.config();

/**
 * Resolves CLI arguments and environment variables.
 * Supports:
 *   1. npm run diagnose --body-part-id right-foot-1
 *   2. npm run diagnose -- --body-part-id right-foot-1
 *   3. npm run diagnose -- --body-part-id=right-foot-1
 *   4. npm run diagnose -- right-foot-1
 */
export function resolveCliConfig(argv: string[] = process.argv.slice(2)): CliConfig {
  let bodyPartId: string | undefined;
  let forceTransform = false;

  const positionalArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--body-part-id" || arg === "--body-part" || arg === "-b") {
      bodyPartId = argv[i + 1];
      i++;
    } else if (arg.startsWith("--body-part-id=")) {
      bodyPartId = arg.slice("--body-part-id=".length);
    } else if (arg === "--force-transform" || arg === "--force" || arg === "-f") {
      forceTransform = true;
    } else if (!arg.startsWith("-")) {
      positionalArgs.push(arg);
    }
  }

  // Fallback to npm's environment variable when invoked as `npm run diagnose --body-part-id right-foot-1`
  if (!bodyPartId) {
    const npmConfigVal = process.env.npm_config_body_part_id;
    if (npmConfigVal && npmConfigVal !== "true" && npmConfigVal !== "false") {
      bodyPartId = npmConfigVal.trim();
    } else if (positionalArgs.length > 0) {
      // When npm consumes `--body-part-id` as a boolean flag ("true"), the value `right-foot-1`
      // is passed by npm as the first positional argument to the script.
      bodyPartId = positionalArgs[0].trim();
    }
  }

  if (process.env.npm_config_force_transform === "true") {
    forceTransform = true;
  }

  if (!bodyPartId) {
    throw new Error(
      "Missing required argument: --body-part-id <body-part>-<id>\n" +
        "Example usage:\n" +
        "  npm run diagnose --body-part-id right-foot-1\n" +
        "  npm run diagnose -- --body-part-id right-foot-1"
    );
  }

  // Sanitize path traversal characters
  const sanitizedId = path.basename(bodyPartId);
  const workspaceRoot = process.cwd();
  const dataDir = path.resolve(workspaceRoot, "data", sanitizedId);

  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    const availableCases = fs.existsSync(path.resolve(workspaceRoot, "data"))
      ? fs
          .readdirSync(path.resolve(workspaceRoot, "data"), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];

    throw new Error(
      `Case directory not found: data/${sanitizedId}\n` +
        (availableCases.length > 0
          ? `Available cases in data/: ${availableCases.join(", ")}`
          : "No case directories found in data/.")
    );
  }

  const reportDir = path.resolve(workspaceRoot, "reports", sanitizedId);
  const montagesDir = path.resolve(reportDir, "montages");

  const clinicalNotesPath = path.join(dataDir, "clinical-notes.txt");
  let clinicalNotes: string | undefined;
  if (
    fs.existsSync(clinicalNotesPath) &&
    fs.statSync(clinicalNotesPath).isFile()
  ) {
    const rawNotes = fs.readFileSync(clinicalNotesPath, "utf-8").trim();
    if (rawNotes.length > 0) {
      clinicalNotes = rawNotes;
    }
  }

  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
  const geminiModel = process.env.GEMINI_MODEL?.trim() || "gemini-4-argon";
  const geminiTranslationModel =
    process.env.GEMINI_TRANSLATION_MODEL?.trim() || "gemini-flash-lite-latest";
  const reportLang = process.env.REPORT_LANG?.trim() || "es-ES";

  return {
    bodyPartId: sanitizedId,
    dataDir,
    reportDir,
    montagesDir,
    forceTransform,
    clinicalNotes,
    geminiApiKey,
    geminiModel,
    geminiTranslationModel,
    reportLang,
  };
}
