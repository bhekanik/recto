"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { type ReactNode, useMemo } from "react";
import { useAppliedAppearance } from "@/lib/studio/use-resolved-appearance";
import { RECTO_HEX } from "@/packages/design-tokens/generated/tokens";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
	throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
}

const convex = new ConvexReactClient(convexUrl);

/**
 * Clerk's widgets get the Recto palette for the resolved appearance. Clerk parses
 * these to derive its own shade scales, so it needs literal sRGB hex — hence the
 * generated table rather than `var(--color-…)`.
 */
function clerkAppearance(resolved: "light" | "dark") {
	const c = RECTO_HEX[resolved];
	return {
		baseTheme: resolved === "dark" ? dark : undefined,
		variables: {
			colorPrimary: c["accent-muted"],
			colorBackground: c["bg-surface"],
			colorText: c["ink-primary"],
			colorTextSecondary: c["ink-tertiary"],
			colorInputBackground: c["bg-raised"],
			colorInputText: c["ink-primary"],
			colorNeutral: c["ink-primary"],
			colorDanger: c.danger,
			colorSuccess: c.success,
			colorWarning: c.warning,
			borderRadius: "0.5rem",
			fontFamily: "var(--font-app-sans)",
		},
	};
}

export function Providers({ children }: { children: ReactNode }) {
	const resolved = useAppliedAppearance();
	const appearance = useMemo(() => clerkAppearance(resolved), [resolved]);

	return (
		<ClerkProvider appearance={appearance}>
			<ConvexProviderWithClerk client={convex} useAuth={useAuth}>
				{children}
			</ConvexProviderWithClerk>
		</ClerkProvider>
	);
}
