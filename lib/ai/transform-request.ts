/**
 * Pure builders for the transform chat request (plan 009). Kept separate from
 * the network call so the prompt shape is unit-testable. Returns an
 * OpenAI-compatible `messages` array consumed by the route handler.
 */

export type ChatMessage = { role: "system" | "user"; content: string };

/** Wire shape the transform route accepts from the client. */
export type TransformRequestBody = {
	/** The instruction (preset prompt or free text). */
	instruction: string;
	/** The exact selected Markdown span to rewrite. */
	selection: string;
};

const TRANSFORM_SYSTEM =
	"You are a precise prose editor embedded in a Markdown writing app. " +
	"You will be given an instruction and a span of the user's text. " +
	"Apply the instruction to the span and return ONLY the rewritten text — " +
	"no preamble, no explanation, no surrounding quotes or code fences, and no " +
	"Markdown you weren't given. Preserve the user's voice and any Markdown " +
	"formatting present in the span unless the instruction says otherwise.";

/** Build the transform chat messages from an instruction + selected span. */
export function buildTransformMessages(
	body: TransformRequestBody,
): ChatMessage[] {
	return [
		{ role: "system", content: TRANSFORM_SYSTEM },
		{
			role: "user",
			content: `Instruction: ${body.instruction}\n\nText:\n${body.selection}`,
		},
	];
}
