/** Wait for Convex auth HTTP routes before starting Next.js (dev only). */
const siteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

if (!siteUrl) {
	process.exit(0);
}

const target = `${siteUrl}/api/auth/convex/jwks`;

for (let attempt = 0; attempt < 30; attempt++) {
	try {
		const res = await fetch(target, { headers: { Origin: origin } });
		if (res.ok) process.exit(0);
	} catch {
		// Convex site may not be ready yet
	}
	await new Promise((resolve) => setTimeout(resolve, 200));
}

process.exit(0);
