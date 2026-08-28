import type { Metadata, Viewport } from "next";
import { Figtree, JetBrains_Mono, Source_Serif_4 } from "next/font/google";

import { Providers } from "@/components/providers";
import { APPEARANCE_SCRIPT } from "@/lib/studio/appearance";
import { cn } from "@/lib/utils";

import "./globals.css";

// Two writing-body faces the user can switch between (à la Bear sans / Substack
// serif) — plus mono for source. Chrome always uses the sans. Variable weights
// give bold headings without extra families.
const sans = Figtree({
	subsets: ["latin"],
	variable: "--font-sans-loaded",
	display: "swap",
	weight: ["400", "500", "600", "700", "800"],
});

// Elegant editorial serif — the optional writing-body face.
const serif = Source_Serif_4({
	subsets: ["latin"],
	variable: "--font-serif-loaded",
	display: "swap",
	weight: ["400", "500", "600", "700"],
	style: ["normal", "italic"],
});

// Raw + Vim source surfaces.
const mono = JetBrains_Mono({
	subsets: ["latin"],
	variable: "--font-mono-loaded",
	display: "swap",
	weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
	title: "Recto",
	description: "A private writing studio — one document, four lenses.",
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	// Don't cap zoom — pinch-zoom stays available for accessibility.
	viewportFit: "cover",
	// Shrink the layout (100dvh) when the on-screen keyboard opens instead of
	// letting it overlay the editor and status bar.
	interactiveWidget: "resizes-content",
	// Matches --color-bg-app in each appearance, so the browser chrome (mobile
	// address bar, PWA splash) never fights the page.
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#f9f6f1" },
		{ media: "(prefers-color-scheme: dark)", color: "#0f101e" },
	],
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="en"
			className={cn(sans.variable, serif.variable, mono.variable)}
			suppressHydrationWarning
		>
			<head>
				{/* Resolves light/dark onto <html> before the first paint, so there is
				    no flash of the wrong appearance. `suppressHydrationWarning` above
				    is required: this script mutates the class React is about to
				    reconcile. */}
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: a blocking
				    inline script is the only way to beat the first paint; the content
				    is a build-time constant with no user input. */}
				<script dangerouslySetInnerHTML={{ __html: APPEARANCE_SCRIPT }} />
			</head>
			<body className="min-h-dvh antialiased">
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
