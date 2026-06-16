export default {
	providers: [
		{
			// Clerk instance issuer (Frontend API URL). Set via `convex env set
			// CLERK_JWT_ISSUER_DOMAIN` on both the dev and prod deployments.
			domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
			applicationID: "convex",
		},
	],
};
