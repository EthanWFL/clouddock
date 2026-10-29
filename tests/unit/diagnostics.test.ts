import { describe, expect, it } from "vitest";
import { formatDiagnosticSummary } from "../../src/main/modules/diagnostics/diagnostics";

describe("formatDiagnosticSummary", () => {
  it("contains only bounded operational metadata", () => {
    const summary = formatDiagnosticSummary({
      appVersion: "0.1.0",
      electronVersion: "43.1.1",
      macOSVersion: "25.5.0",
      architecture: "arm64",
      tabCount: 6,
      liveViewCount: 4,
      processCount: 9,
      totalWorkingSetBytes: 512 * 1024 * 1024,
      recycledViewCount: 10,
      reloadedAfterRecycleCount: 2,
      peakLiveViewCount: 5,
    });

    expect(summary).toBe([
      "CloudDock 0.1.0",
      "macOS 25.5.0 (arm64)",
      "Electron 43.1.1",
      "Tabs: 6",
      "Live views: 4",
      "Processes: 9",
      "Working set: 512 MB",
      "Recycled views: 10",
      "Reloads after recycle: 2",
      "Peak live views: 5",
    ].join("\n"));
    expect(summary).not.toMatch(/https?:|cookie|resource|tab-/i);
  });

  it("clamps invalid negative counters", () => {
    const summary = formatDiagnosticSummary({
      appVersion: "0.1.0",
      electronVersion: "43.1.1",
      macOSVersion: "25.5.0",
      architecture: "arm64",
      tabCount: -1,
      liveViewCount: -2,
      processCount: -3,
      totalWorkingSetBytes: -1,
      recycledViewCount: -1,
      reloadedAfterRecycleCount: -1,
      peakLiveViewCount: -1,
    });

    expect(summary).toContain("Tabs: 0");
    expect(summary).toContain("Live views: 0");
    expect(summary).toContain("Processes: 0");
    expect(summary).toContain("Working set: 0 MB");
    expect(summary).toContain("Recycled views: 0");
    expect(summary).toContain("Reloads after recycle: 0");
    expect(summary).toContain("Peak live views: 0");
  });
});
