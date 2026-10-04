"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { describeMotionError, updateMotionBlock } from "./motion-client";
import { findMotionMisfits } from "./motion-misfits";

const SETTLE_MS = 700;

/**
 * Stretching or trimming a motion block in the timeline renders it again at its new length, so the entrance
 * stays at the start and the exit at the end. Mounted once in the editor; renders nothing.
 */
export function MotionAutoFit(): null {
	const tracks = useEditor((editor) => editor.scenes.getActiveSceneOrNull()?.tracks ?? null);
	const assets = useEditor((editor) => editor.media.getAssets());
	const running = useRef(false);
	// A fit that failed is not retried until the element changes again.
	const failed = useRef(new Set<string>());

	useEffect(() => {
		if (!tracks) return;
		const pending = findMotionMisfits({ tracks, assets }).filter(
			(misfit) => !failed.current.has(misfit.key),
		);
		const next = pending[0];
		if (!next) return;
		const timer = window.setTimeout(() => {
			if (running.current) return;
			running.current = true;
			updateMotionBlock({ elementId: next.elementId, duration: next.duration })
				.catch((error: unknown) => {
					failed.current.add(next.key);
					toast.error("Le bloc n'a pas pu être recalé sur sa nouvelle durée", {
						description: describeMotionError(error),
					});
				})
				.finally(() => {
					running.current = false;
				});
		}, SETTLE_MS);
		return () => window.clearTimeout(timer);
	}, [tracks, assets]);

	return null;
}
