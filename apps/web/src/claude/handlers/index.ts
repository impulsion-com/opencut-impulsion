import { editHandlers } from "@/claude/edit/edit-handlers";
import { coreHandlers } from "@/claude/handlers/core-handlers";
import { internalHandlers } from "@/claude/handlers/internal-handlers";
import {
	registerTabHandlers,
	warnMissingTabHandlersOnce,
} from "@/claude/handlers/registry";

// Registers every tab handler module. Loaded lazily by the bridge client (browser only), so handler modules may
// use browser APIs at module level. A new module = one import and one registerTabHandlers line here.

registerTabHandlers({
	handlers: internalHandlers,
	owner: "internal-handlers (S)",
});
registerTabHandlers({ handlers: coreHandlers, owner: "core-handlers (E1)" });
registerTabHandlers({ handlers: editHandlers, owner: "edit-handlers (E2)" });

warnMissingTabHandlersOnce();
