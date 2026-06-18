/**
 * Server-only OpenRouter client + auth guard for the AI route handlers
 * (plan 009, provider override). The key (`OPENROUTER_API_KEY`) is read here from
 * the Next.js server env and NEVER reaches the client. Importing this in a client
 * component is a build error (`server-only`).
 */

import "server-only";

import { auth } from "@clerk/nextjs/server";
import OpenAI from "openai";

import { OPENROUTER_BASE_URL } from "./config";

/** Construct the OpenAI SDK pointed at OpenRouter. Throws if the key is absent. */
export function openRouter(): OpenAI {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		throw new Error("OPENROUTER_API_KEY is not set on the server");
	}
	return new OpenAI({
		apiKey,
		baseURL: OPENROUTER_BASE_URL,
		// Optional attribution headers OpenRouter recommends; harmless if unset.
		defaultHeaders: {
			"HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL ?? "https://recto.app",
			"X-Title": "Recto",
		},
	});
}

/**
 * Require a Clerk-authenticated user. Returns the user id, or null if
 * unauthenticated (the route handler should then respond 401). Mirrors the
 * Convex `requireUserId` boundary on the Next side.
 */
export async function requireUser(): Promise<string | null> {
	const { userId } = await auth();
	return userId ?? null;
}
