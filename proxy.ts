import { clerkMiddleware } from "@clerk/nextjs/server";

// Next.js 16 renamed the middleware entry from `middleware.ts` to `proxy.ts`.
// clerkMiddleware() attaches Clerk's auth context to every request; route
// protection is handled client-side in the studio shell (redirect to /login).
export default clerkMiddleware();

export const config = {
	matcher: [
		// Skip Next internals and static files, run on everything else + API routes.
		"/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		"/(api|trpc)(.*)",
	],
};
