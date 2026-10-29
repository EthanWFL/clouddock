import { z } from "zod";
import { WorkspaceCommandSchema, WorkspaceSnapshotSchema } from "./model";
export { IPC_CHANNELS } from "./ipc-channels";

export const ViewBoundsSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  visible: z.boolean(),
});
export type ViewBounds = z.infer<typeof ViewBoundsSchema>;

export const NativeMenuSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("app") }),
  z.object({ type: z.literal("favorite"), id: z.string().min(1) }),
  z.object({ type: z.literal("module-shortcut"), id: z.string().min(1) }),
]);
export type NativeMenuRequest = z.infer<typeof NativeMenuSchema>;
export type NativeMenuAction = "diagnostics" | "credentials" | "logout" | "move-up" | "move-down" | "rename" | "remove";

export const ViewActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("forward") }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("open-system") }),
  z.object({ type: z.literal("copy-link") }),
  z.object({
    type: z.literal("find"),
    text: z.string().min(1).max(500),
    forward: z.boolean(),
    findNext: z.boolean(),
  }),
  z.object({ type: z.literal("stop-find"), restoreFocus: z.boolean().optional() }),
]);
export type ViewAction = z.infer<typeof ViewActionSchema>;

export interface PageFindResult {
  tabId: string;
  text: string;
  activeMatchOrdinal: number;
  matches: number;
}

export const IpcSchemas = {
  workspaceCommand: WorkspaceCommandSchema,
  workspaceSnapshot: WorkspaceSnapshotSchema,
  viewBounds: ViewBoundsSchema,
  viewAction: ViewActionSchema,
};
