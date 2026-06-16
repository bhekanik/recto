"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import type { ReactNode } from "react";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
	throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
}

const convex = new ConvexReactClient(convexUrl);

// Clerk widgets themed to Recto's warm-dark surface + coral accent.
const clerkAppearance = {
	baseTheme: dark,
	variables: {
		colorPrimary: "#f9826c",
		colorBackground: "#1f1c17",
		colorText: "#efe9df",
		colorTextSecondary: "#c3bcaf",
		colorInputBackground: "#27231d",
		colorInputText: "#efe9df",
		colorNeutral: "#efe9df",
		borderRadius: "0.5rem",
		fontFamily: "var(--font-app-sans)",
	},
};

export function Providers({ children }: { children: ReactNode }) {
	return (
		<ClerkProvider appearance={clerkAppearance}>
			<ConvexProviderWithClerk client={convex} useAuth={useAuth}>
				{children}
			</ConvexProviderWithClerk>
		</ClerkProvider>
	);
}
