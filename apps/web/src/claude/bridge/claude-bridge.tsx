"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { claudeBridge } from "./client";

/**
 * Keeps the tab connected to the Claude sidecar for the whole session (mounted once in the root layout, so it
 * survives navigation between /projects and /editor/<id>). Renders nothing. StrictMode-safe: retain() is
 * ref-counted and its release only stops the bridge on the next tick if nothing re-acquired it.
 */
export function ClaudeBridge(): null {
	useEffect(() => claudeBridge.retain(), []);
	// Soft navigations (router.push) do not reload the page: tell the hub where the tab now is.
	const pathname = usePathname();
	useEffect(() => {
		claudeBridge.notifyNavigation();
	}, [pathname]);
	return null;
}
