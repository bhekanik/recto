/**
 * Preset transform instructions for the reversible AI selection transform
 * (plan 009, Phase A). Pure data + types — no I/O. Each preset's `prompt` is the
 * user-facing instruction sent to the model alongside the selected span; the
 * model returns ONLY the rewritten span (the system prompt in the route handler
 * enforces that).
 */

export type TransformPresetId =
	| "tighten"
	| "rewrite"
	| "expand"
	| "fix-grammar";

export type TransformPreset = {
	id: TransformPresetId;
	/** Short label for the picker UI. */
	label: string;
	/** The instruction handed to the model. */
	prompt: string;
};

export const TRANSFORM_PRESETS: TransformPreset[] = [
	{
		id: "tighten",
		label: "Tighten",
		prompt:
			"Tighten this prose. Cut redundancy and filler; keep the meaning, voice, and Markdown formatting intact.",
	},
	{
		id: "rewrite",
		label: "Rewrite",
		prompt:
			"Rewrite this passage to read more clearly and naturally, preserving its meaning and Markdown formatting.",
	},
	{
		id: "expand",
		label: "Expand",
		prompt:
			"Expand this passage with a little more detail and supporting texture, staying on topic and preserving Markdown formatting.",
	},
	{
		id: "fix-grammar",
		label: "Fix grammar",
		prompt:
			"Correct grammar, spelling, and punctuation only. Do not change wording, meaning, voice, or Markdown formatting beyond what the corrections require.",
	},
];

/** Look up a preset by id (undefined for a free-text instruction). */
export function findPreset(id: string): TransformPreset | undefined {
	return TRANSFORM_PRESETS.find((p) => p.id === id);
}

/**
 * Short label for an AI history node, derived from its instruction. Used to
 * encode `origin` as `ai:<label>` so the history panel can show what the AI did.
 */
export function instructionLabel(input: {
	presetId?: string;
	freeText?: string;
}): string {
	const preset = input.presetId ? findPreset(input.presetId) : undefined;
	if (preset) return preset.label;
	const text = input.freeText?.trim();
	if (text) return text.length > 24 ? `${text.slice(0, 24)}…` : text;
	return "edit";
}
