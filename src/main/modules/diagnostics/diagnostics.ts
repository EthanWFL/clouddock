export interface DiagnosticSummaryInput {
  appVersion: string;
  electronVersion: string;
  macOSVersion: string;
  architecture: string;
  tabCount: number;
  liveViewCount: number;
  processCount: number;
  totalWorkingSetBytes: number;
  recycledViewCount: number;
  reloadedAfterRecycleCount: number;
  peakLiveViewCount: number;
}

function formatMegabytes(bytes: number): string {
  return `${Math.max(0, Math.round(bytes / 1024 / 1024))} MB`;
}

export function formatDiagnosticSummary(input: DiagnosticSummaryInput): string {
  return [
    `CloudDock ${input.appVersion}`,
    `macOS ${input.macOSVersion} (${input.architecture})`,
    `Electron ${input.electronVersion}`,
    `Tabs: ${Math.max(0, input.tabCount)}`,
    `Live views: ${Math.max(0, input.liveViewCount)}`,
    `Processes: ${Math.max(0, input.processCount)}`,
    `Working set: ${formatMegabytes(input.totalWorkingSetBytes)}`,
    `Recycled views: ${Math.max(0, input.recycledViewCount)}`,
    `Reloads after recycle: ${Math.max(0, input.reloadedAfterRecycleCount)}`,
    `Peak live views: ${Math.max(0, input.peakLiveViewCount)}`,
  ].join("\n");
}
