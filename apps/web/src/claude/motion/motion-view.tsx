"use client";

import { useState } from "react";
import { toast } from "sonner";
import { MOTION_BLOCKS } from "@opencut/motion-blocks/catalog";
import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { mediaTimeToSeconds } from "@/wasm";
import { addMotionBlock, describeMotionError } from "./motion-client";

/** The "Motion" view of the assets panel: every block, added at the playhead with its default texts. */
export function MotionView() {
	const editor = useEditor();
	const [adding, setAdding] = useState<string | null>(null);

	const add = async (blockId: string) => {
		setAdding(blockId);
		try {
			const start =
				Math.round(
					mediaTimeToSeconds({ time: editor.playback.getCurrentTime() }) * 1000,
				) / 1000;
			await addMotionBlock({ block: blockId, start });
		} catch (error) {
			toast.error("Le bloc n'a pas pu être ajouté", {
				description: describeMotionError(error),
			});
		} finally {
			setAdding(null);
		}
	};

	return (
		<PanelView title="Motion design">
			<div className="flex flex-col gap-2 pb-4">
				<p className="text-muted-foreground px-1 text-xs">
					Un bloc est ajouté à la position de la tête de lecture. Sélectionne-le ensuite pour
					changer ses textes et sa durée.
				</p>
				{MOTION_BLOCKS.map((block) => (
					<div key={block.id} className="flex flex-col gap-1.5 rounded-md border p-2.5">
						<span className="text-sm font-medium">{block.label}</span>
						<span className="text-muted-foreground text-xs">{block.description}</span>
						<Button
							variant="outline"
							size="sm"
							className="self-start"
							disabled={adding !== null}
							onClick={() => add(block.id)}
						>
							{adding === block.id ? "Rendu en cours…" : "Ajouter"}
						</Button>
					</div>
				))}
			</div>
		</PanelView>
	);
}
