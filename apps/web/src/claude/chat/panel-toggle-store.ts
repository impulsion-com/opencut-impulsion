import { create } from "zustand";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { usePanelStore } from "@/editor/panel-store";

// Imperative control of the Claude column (the 4th ResizablePanel of EditorLayout) for the header toggle. The
// open/closed state itself is persisted in the panel store (claudeCollapsed) through the panel's
// onCollapse/onExpand callbacks, so a drag to the edge and the button stay in sync.

interface ClaudePanelControlState {
	handle: ImperativePanelHandle | null;
	setHandle(handle: ImperativePanelHandle | null): void;
}

export const useClaudePanelControl = create<ClaudePanelControlState>()(
	(set) => ({
		handle: null,
		setHandle: (handle) => set({ handle }),
	}),
);

export function openClaudePanel(): void {
	const { handle } = useClaudePanelControl.getState();
	const { panels, setClaudeCollapsed } = usePanelStore.getState();
	if (!handle) {
		setClaudeCollapsed(false);
		return;
	}
	// expand() restores the size from before the collapse; after a reload that memory is gone, so pass the
	// persisted width as the floor.
	if (handle.isCollapsed()) handle.expand(panels.claude);
}

export function closeClaudePanel(): void {
	const { handle } = useClaudePanelControl.getState();
	if (!handle) {
		usePanelStore.getState().setClaudeCollapsed(true);
		return;
	}
	if (!handle.isCollapsed()) handle.collapse();
}

export function toggleClaudePanel(): void {
	if (usePanelStore.getState().claudeCollapsed) openClaudePanel();
	else closeClaudePanel();
}
