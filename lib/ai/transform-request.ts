/**
 * Pure builders for the transform + critique chat requests (plan 009). Kept
 * separate from the network call so the prompt shape is unit-testable. Returns
 * OpenAI-compatible `messages` arrays consumed by the route handlers.
 */

export type ChatMessage = { role: "system" | "user"; content: string };

/** Wire shape the transform route accepts from the client. */
export type TransformRequestBody = {
	/** The instruction (preset prompt or free text). */
	instruction: string;
	/** The exact selected Markdown span to rewrite. */
	selection: string;
};

/** Wire shape the critique route accepts from the client. */
export type CritiqueRequestBody = {
	/** The section or whole-document Markdown to critique. */
	text: string;
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

const CRITIQUE_SYSTEM =
	"You are a sharp, kind developmental editor. Read the passage and give " +
	"qualitative, READ-ONLY feedback — do NOT rewrite or edit the text. " +
	'Return a JSON object with a single key "notes": an array of ' +
	'{ "category": string, "note": string } items. Categories are short labels ' +
	'like "Clarity", "Pacing", "Structure", "Tone", "Argument". Each note is one ' +
	"or two sentences pointing to something specific — what's weak, what drags, " +
	"what's confusing — and why. 3 to 6 notes. Output ONLY the JSON object.";

/** Build the critique chat messages from a section/document. */
export function buildCritiqueMessages(
	body: CritiqueRequestBody,
): ChatMessage[] {
	return [
		{ role: "system", content: CRITIQUE_SYSTEM },
		{ role: "user", content: body.text },
	];
}

/** One piece of critique feedback (the parsed model output). */
export type CritiqueNote = { category: string; note: string };

/**
 * Parse the model's critique reply into notes, tolerating fenced JSON or stray
 * prose around the object. Returns [] if nothing parseable is found (the panel
 * then shows an empty state rather than throwing). Pure.
 */
export function parseCritique(raw: string): CritiqueNote[] {
	const text = raw.trim();
	// Strip a ```json … ``` fence if present.
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced?.[1]?.trim() ?? text;
	// Find the first {...} object.
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return [];
	}
	const notes = (parsed as { notes?: unknown }).notes;
	if (!Array.isArray(notes)) return [];
	const out: CritiqueNote[] = [];
	for (const item of notes) {
		if (item && typeof item === "object") {
			const category = (item as { category?: unknown }).category;
			const note = (item as { note?: unknown }).note;
			if (typeof category === "string" && typeof note === "string") {
				out.push({ category, note });
			}
		}
	}
	return out;
}
