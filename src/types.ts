export interface CliConfig {
  bodyPartId: string;
  dataDir: string;
  reportDir: string;
  montagesDir: string;
  forceTransform: boolean;
  clinicalNotes?: string;
  geminiApiKey?: string;
  geminiModel: string;
  geminiTranslationModel: string;
  reportLang: string;
}

export interface DiscoveredAssets {
  hasMri: boolean;
  hasXray: boolean;
  mriDicomFiles: string[];
  xrayImageFiles: string[];
  xrayDicomFiles: string[];
}

export interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DicomSlice {
  filePath: string;
  modality: string;
  studyDescription: string;
  seriesDescription: string;
  protocolName: string;
  bodyPartExamined: string;
  sliceThickness: string;
  seriesNumber: number;
  instanceNumber: number;
  rows: number;
  cols: number;
  windowCenter?: number;
  windowWidth?: number;
  pixelSpacing?: [number, number];
  sliceLocation?: number;
  imagePositionPatient?: [number, number, number];
  imageOrientationPatient?: [number, number, number, number, number, number];
  pixels8Bit: Uint8Array;
}

export interface MriSeriesGroup {
  seriesNumber: number;
  seriesDescription: string;
  protocolName: string;
  studyDescription: string;
  bodyPartExamined: string;
  sliceThickness: string;
  rows: number;
  cols: number;
  pixelSpacing?: [number, number];
  imageOrientationPatient?: [number, number, number, number, number, number];
  cropBox: CropBox;
  slices: DicomSlice[];
}

export interface MriSeriesMetadata {
  seriesNumber: number;
  seriesDescription: string;
  protocolName: string;
  sliceThickness: string;
  sliceCount: number;
  rows: number;
  cols: number;
  croppedCols?: number;
  croppedRows?: number;
  pixelSpacingMm?: [number, number];
  montageFile: string;
  panelFiles: string[];
}

export interface PairedMriSeriesMetadata {
  plane: string;
  t1SeriesNumber: number;
  t1SeriesDescription: string;
  fluidSeriesNumber: number;
  fluidSeriesDescription: string;
  pairCount: number;
  panelFiles: string[];
}

export interface XrayAssetMetadata {
  file: string;
  originalName: string;
  width: number;
  height: number;
  sourceType: "image" | "dicom";
  seriesDescription?: string;
}

export interface TransformationManifest {
  version: number;
  bodyPartId: string;
  createdAt: string;
  studyDescription: string;
  bodyPartExamined: string;
  modalities: Array<"mri" | "x-ray">;
  mriSeries: MriSeriesMetadata[];
  pairedMriSeries?: PairedMriSeriesMetadata[];
  xrayImages: XrayAssetMetadata[];
}
