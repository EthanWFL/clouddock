import type { OpsDockApi } from "../../shared/api";

declare global {
  interface Window {
    opsdock: OpsDockApi;
  }
}

export {};
