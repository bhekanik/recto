export const CONVEX_SITE_URL =
	process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
	(process.env.NEXT_PUBLIC_CONVEX_URL ?? "").replace(
		".convex.cloud",
		".convex.site",
	);

export function requireConvexSiteUrl(): string {
	if (!CONVEX_SITE_URL) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
	return CONVEX_SITE_URL;
}
