// Content versions for texture sources whose pixels change while the object stays the same.
// The video cache decodes into a small pool of reused canvases (mediabunny CanvasSink poolSize), so a new frame
// often lands in the very canvas the compositor uploaded last time. Caches keyed on object identity alone would
// then keep showing the old pixels (a seek showing a stale frame). Whoever overwrites a source bumps its version;
// texture caches compare the version along with the identity.

const versions = new WeakMap<object, number>();

/** Marks that `source` now holds new pixels. */
export function bumpSourceVersion(source: object): void {
	versions.set(source, (versions.get(source) ?? 0) + 1);
}

/** 0 for a source nobody has bumped (static images, stickers). */
export function getSourceVersion(source: unknown): number {
	if (typeof source !== "object" || source === null) return 0;
	return versions.get(source) ?? 0;
}
