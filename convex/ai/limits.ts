import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";

export const aiRateLimiter = new RateLimiter(components.rateLimiter, {
	aiRequests: {
		kind: "token bucket",
		rate: 20,
		period: MINUTE,
		capacity: 20,
	},
});
