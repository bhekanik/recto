import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const convexSiteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;

if (!convexUrl || !convexSiteUrl) {
	throw new Error(
		"NEXT_PUBLIC_CONVEX_URL and NEXT_PUBLIC_CONVEX_SITE_URL must be set",
	);
}

const {
	handler: baseHandler,
	preloadAuthQuery,
	isAuthenticated,
	getToken,
	fetchAuthQuery,
	fetchAuthMutation,
	fetchAuthAction,
} = convexBetterAuthNextJs({
	convexUrl,
	convexSiteUrl,
});

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const MAX_AUTH_PROXY_ATTEMPTS = 4;

/** Convex HTTP/component queries can briefly 500 during dev redeploys. */
async function retryAuthProxy(
	request: Request,
	fn: (request: Request) => Promise<Response>,
): Promise<Response> {
	const bodyBuffer =
		request.method === "GET" || request.method === "HEAD"
			? null
			: await request.arrayBuffer();

	const attemptRequest = () => {
		if (bodyBuffer === null) return request;
		return new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body: bodyBuffer.byteLength > 0 ? bodyBuffer : undefined,
		});
	};

	let last: Response | null = null;
	for (let attempt = 0; attempt < MAX_AUTH_PROXY_ATTEMPTS; attempt++) {
		last = await fn(attemptRequest());
		if (!RETRYABLE_STATUSES.has(last.status)) return last;
		if (attempt < MAX_AUTH_PROXY_ATTEMPTS - 1) {
			await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
		}
	}
	return last as Response;
}

export const handler = {
	GET: (request: Request) => retryAuthProxy(request, baseHandler.GET),
	POST: (request: Request) => retryAuthProxy(request, baseHandler.POST),
};

export {
	fetchAuthAction,
	fetchAuthMutation,
	fetchAuthQuery,
	getToken,
	isAuthenticated,
	preloadAuthQuery,
};
