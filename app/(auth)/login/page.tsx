"use client";

import { SignIn } from "@clerk/nextjs";

import { MacAppSignInNote } from "@/components/handoff/mac-app-sign-in-note";

export default function LoginPage() {
	return (
		<main className="flex min-h-dvh flex-col items-center justify-center bg-[var(--color-bg-app)] px-[var(--space-6)] py-[var(--space-8)]">
			<div className="flex w-full max-w-sm flex-col items-center gap-[var(--space-7)]">
				<div className="space-y-[var(--space-3)] text-center">
					<h1 className="font-[family-name:var(--font-app-serif)] text-[length:var(--text-display)] leading-[var(--leading-display)] font-semibold tracking-tight text-[var(--color-ink-primary)]">
						Recto
					</h1>
					<p className="text-[length:var(--text-ui-sm)] leading-[var(--leading-ui-sm)] text-[var(--color-ink-tertiary)]">
						Return to your writing studio.
					</p>
				</div>

				<SignIn
					routing="hash"
					fallbackRedirectUrl="/"
					signUpFallbackRedirectUrl="/"
				/>

				<MacAppSignInNote />
			</div>
		</main>
	);
}
