/**
 * Shared, locale-default timestamp formatter for the review surfaces (comments
 * panel + owner review). Module-level so the Intl object is constructed once and
 * reused across renders. Both panels showed identical "Mon D, H:MM" stamps; this
 * is the single source of those options.
 */
export const timeFmt = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});
