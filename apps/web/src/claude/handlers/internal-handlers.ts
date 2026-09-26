import type { TabHandlerMap } from "@/claude/types";
import { jsonResult } from "@/claude/types";

// Internal methods owned by the skeleton (agent S). The import/export halves (internal.import_files,
// internal.export_start, internal.export_cancel) belong to the agent that implements import_media and start_export.

export const internalHandlers: TabHandlerMap = {
	"internal.ping": async () => jsonResult({ ok: true }),
};
