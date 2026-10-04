"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	clampMotionDuration,
	getMotionBlock,
	type MotionProps,
} from "@opencut/motion-blocks/catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import type { VideoElement } from "@/timeline";
import { mediaTimeToSeconds } from "@/wasm";
import {
	describeMotionError,
	fetchMotionMedia,
	updateMotionBlock,
	type MotionMediaInfo,
} from "./motion-client";
import { MotionFields } from "./motion-fields";

type Loaded =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; info: MotionMediaInfo };

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

/** Settings of a motion block: texts, placement and duration. "Appliquer" renders it again in place. */
export function MotionTab({ element }: { element: VideoElement }) {
	const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
	const [draft, setDraft] = useState<MotionProps>({});
	const [duration, setDuration] = useState("");
	const [busy, setBusy] = useState(false);

	// The timeline can say more than the last render: the element may have been trimmed or stretched by hand.
	const onTimeline = round2(mediaTimeToSeconds({ time: element.duration }));

	useEffect(() => {
		const controller = new AbortController();
		setLoaded({ status: "loading" });
		fetchMotionMedia({ mediaId: element.mediaId, signal: controller.signal })
			.then((info) => {
				setLoaded({ status: "ready", info });
				setDraft(info.props);
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				setLoaded({ status: "error", message: describeMotionError(error) });
			});
		return () => controller.abort();
	}, [element.mediaId]);

	useEffect(() => {
		setDuration(String(onTimeline));
	}, [onTimeline]);

	if (loaded.status === "loading") {
		return <p className="text-muted-foreground p-4 text-sm">Chargement du bloc…</p>;
	}
	if (loaded.status === "error") {
		return <p className="text-muted-foreground p-4 text-sm">{loaded.message}</p>;
	}

	const { info } = loaded;
	const block = getMotionBlock(info.block);
	if (!block) {
		return (
			<p className="text-muted-foreground p-4 text-sm">
				Bloc inconnu de cette version de l'éditeur : {info.block}
			</p>
		);
	}

	const parsedDuration = Number.parseFloat(duration.replace(",", "."));
	const nextDuration = Number.isFinite(parsedDuration)
		? round2(clampMotionDuration(block, parsedDuration))
		: round2(info.duration);
	const changed =
		JSON.stringify(draft) !== JSON.stringify(info.props) ||
		Math.abs(nextDuration - info.duration) > 0.02;

	const apply = async () => {
		setBusy(true);
		try {
			const result = await updateMotionBlock({
				elementId: element.id,
				props: draft,
				duration: nextDuration,
			});
			setLoaded({ status: "ready", info: result });
			setDraft(result.props);
		} catch (error) {
			toast.error("Le bloc n'a pas pu être recalculé", {
				description: describeMotionError(error),
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section sectionKey={`${element.id}:motion`}>
			<SectionHeader>
				<SectionTitle>{block.label}</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<MotionFields
						fields={block.fields}
						values={draft}
						onChange={setDraft}
						disabled={busy}
					/>
					<SectionField label="Durée (secondes)">
						<Input
							value={duration}
							inputMode="decimal"
							disabled={busy}
							onChange={(event) => setDuration(event.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							Tu peux aussi étirer ou raccourcir le bloc dans la timeline : il se recale tout
							seul sur sa nouvelle durée.
						</p>
					</SectionField>
					<Button onClick={apply} disabled={busy || !changed}>
						{busy ? "Rendu en cours…" : "Appliquer"}
					</Button>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
