"use client";

import { AppWindowMac } from "lucide-react";
import { useEffect, useState } from "react";

import { isMacOSPlatform } from "@/lib/handoff/document-link";
import {
	MAC_APP_DOWNLOAD_URL,
	MAC_APP_REQUIREMENTS,
} from "@/lib/handoff/mac-app";

/**
 * One quiet line under the sign-in form, on a Mac only: the same studio is a
 * native app too. Decided after mount, so the server render and the first
 * client render agree.
 */
export function MacAppSignInNote() {
	const [isMac, setIsMac] = useState(false);
	useEffect(() => setIsMac(isMacOSPlatform()), []);
	if (!isMac) return null;

	return (
		<p className="flex items-center gap-[var(--space-2)] text-[length:var(--text-ui-sm)] text-[var(--color-ink-tertiary)]">
			<AppWindowMac aria-hidden className="size-4 shrink-0" />
			<span>
				Also on Mac.{" "}
				<a
					href={MAC_APP_DOWNLOAD_URL}
					title={MAC_APP_REQUIREMENTS}
					className="text-[var(--color-ink-secondary)] underline decoration-[var(--color-line-strong)] underline-offset-4 transition-colors hover:text-[var(--color-ink-primary)] hover:decoration-current"
				>
					Download Recto for Mac
				</a>
			</span>
		</p>
	);
}
