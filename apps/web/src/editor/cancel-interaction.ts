type CancelFn = () => void;

const cancellers = new Set<CancelFn>();
/** The cancellers of pointer gestures in progress (drags, resizes, handles): a subset of `cancellers`. */
const gestures = new Set<CancelFn>();

export function registerCanceller({
	fn,
	gesture = true,
}: {
	fn: CancelFn;
	/** false for an open editing surface rather than a pointer gesture (e.g. the graph editor popover). */
	gesture?: boolean;
}): () => void {
	cancellers.add(fn);
	if (gesture) gestures.add(fn);

	return () => {
		cancellers.delete(fn);
		gestures.delete(fn);
	};
}

/** True while the user drags, resizes or moves a handle anywhere in the editor (edits made meanwhile would race it). */
export function hasActiveGesture(): boolean {
	return gestures.size > 0;
}

export function cancelInteraction(): boolean {
	if (cancellers.size === 0) return false;

	const activeCancellers = Array.from(cancellers);
	cancellers.clear();
	gestures.clear();

	for (const cancel of activeCancellers) {
		cancel();
	}

	return true;
}
