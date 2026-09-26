import type { TabHandlerMap } from "@/claude/types";
import { handleApplyEditPlan } from "./apply-plan";
import { handleRedo, handleUndo } from "./history";
import { handleMarkRanges } from "./mark-ranges";

// Editing tab tools (agent E2): apply_edit_plan, mark_ranges, undo, redo. Every mutating call is one history entry
// built with runAiEdit (ai-edit.ts); handlers/index.ts registers this map.

/** Identity: the (input, ctx) signature of each handler is dictated by TabHandler, not chosen here. */
function defineHandlers(handlers: TabHandlerMap): TabHandlerMap {
	return handlers;
}

export const editHandlers = defineHandlers({
	apply_edit_plan: (input, ctx) => handleApplyEditPlan({ input, ctx }),
	mark_ranges: (input, ctx) => handleMarkRanges({ input, ctx }),
	undo: (input, ctx) => handleUndo({ input, ctx }),
	redo: (input, ctx) => handleRedo({ input, ctx }),
});
