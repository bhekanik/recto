"use client";

import { createContext, useContext } from "react";

import type { StudioSettingsApi } from "./use-studio-settings";

const StudioSettingsContext = createContext<StudioSettingsApi | null>(null);

export function StudioSettingsProvider({
	value,
	children,
}: {
	value: StudioSettingsApi;
	children: React.ReactNode;
}) {
	return (
		<StudioSettingsContext.Provider value={value}>
			{children}
		</StudioSettingsContext.Provider>
	);
}

/**
 * Read studio settings from deep in the pane tree (e.g. the CodeMirror surface
 * needs `spellcheck`), avoiding prop-drilling through the recursive renderer.
 */
export function useStudioSettingsContext(): StudioSettingsApi {
	const value = useContext(StudioSettingsContext);
	if (!value) {
		throw new Error(
			"useStudioSettingsContext must be used within a StudioSettingsProvider",
		);
	}
	return value;
}
