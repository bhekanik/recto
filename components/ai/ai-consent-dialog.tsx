"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function AiConsentDialog(props: {
	open: boolean;
	busy: boolean;
	onOpenChange: (open: boolean) => void;
	onAccept: () => void;
}) {
	return (
		<AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Enable AI features?</AlertDialogTitle>
					<AlertDialogDescription>
						Recto sends the selected text or draft to OpenRouter and the model
						provider for transforms, reviews, and related-passage search. Full
						inputs and outputs are also sent to LangSmith for tracing and evals.
						Your saved OpenRouter key is used when configured; otherwise an
						eligible Recto house key is used. You can turn AI off later.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={props.busy}>Decline</AlertDialogCancel>
					<AlertDialogAction disabled={props.busy} onClick={props.onAccept}>
						{props.busy ? "Enabling…" : "Accept and enable"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
