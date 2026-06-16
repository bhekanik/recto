import type { Metadata } from "next";
import { Figtree, JetBrains_Mono, Source_Serif_4 } from "next/font/google";

import { Providers } from "@/components/providers";
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

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="en"
			className={cn("dark", sans.variable, serif.variable, mono.variable)}
		>
			<body className="min-h-dvh antialiased">
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
