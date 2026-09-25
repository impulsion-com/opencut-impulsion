"use client";

import { ArrowRightIcon } from "lucide-react";
import { useLocalStorage } from "@/services/storage/use-local-storage";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../ui/dialog";

const WELCOME_TITLE = "Bienvenue dans OpenCut Impulsion";

export function Onboarding() {
	const [hasSeenOnboarding, setHasSeenOnboarding] = useLocalStorage({
		key: "hasSeenOnboarding",
		defaultValue: false,
	});

	const isOpen = !hasSeenOnboarding;

	const handleClose = () => {
		setHasSeenOnboarding({ value: true });
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogTitle>
					<span className="sr-only">{WELCOME_TITLE}</span>
				</DialogTitle>
				<DialogBody>
					<div className="space-y-5">
						<div className="space-y-3">
							<h2 className="text-lg font-bold md:text-xl">{WELCOME_TITLE}</h2>
							<p className="text-muted-foreground">
								Tout reste sur cette machine : les projets et les médias sont
								enregistrés dans ce navigateur, sans compte ni service externe.
							</p>
						</div>
						<Button onClick={handleClose} variant="default" className="w-full">
							Commencer
							<ArrowRightIcon className="size-4" />
						</Button>
					</div>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
