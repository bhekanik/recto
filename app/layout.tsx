import type { Metadata } from "next";

import { Providers } from "@/components/providers";
import { getToken } from "@/lib/auth-server";

import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
	title: "Recto",
	description: "Writing studio — canonical Markdown",
};

export default async function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	let token: string | null = null;
	try {
		token = (await getToken()) ?? null;
	} catch {
		// Convex may not be running yet (e.g. during startup)
	}

	return (
		<html lang="en" className={cn("dark font-sans", geist.variable)}>
			<body className="min-h-dvh antialiased">
				<Providers initialToken={token}>{children}</Providers>
			</body>
		</html>
	);
}
