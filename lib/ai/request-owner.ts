export type AiRequestTicket = {
	generation: number;
	requestId: string;
	documentId: string;
	controller: AbortController;
	phase: "local" | "sent";
};

/** Own one client request before any asynchronous setup can yield. */
export class AiRequestOwner {
	private generation = 0;
	private current: AiRequestTicket | null = null;

	begin(documentId: string): AiRequestTicket {
		this.supersede();
		const ticket: AiRequestTicket = {
			generation: this.generation,
			requestId: crypto.randomUUID(),
			documentId,
			controller: new AbortController(),
			phase: "local",
		};
		this.current = ticket;
		return ticket;
	}

	isCurrent(ticket: AiRequestTicket, documentId: string | null): boolean {
		return (
			this.current === ticket &&
			ticket.generation === this.generation &&
			ticket.documentId === documentId &&
			!ticket.controller.signal.aborted
		);
	}

	markSent(ticket: AiRequestTicket): boolean {
		if (this.current !== ticket || ticket.generation !== this.generation) {
			return false;
		}
		ticket.phase = "sent";
		return true;
	}

	finish(ticket: AiRequestTicket): void {
		if (this.current === ticket) this.current = null;
	}

	currentRequestId(): string | null {
		return this.current?.requestId ?? null;
	}

	supersedeIfCurrent(ticket: AiRequestTicket): "local" | "sent" | null {
		return this.current === ticket ? this.supersede() : null;
	}

	supersede(): "local" | "sent" | null {
		const phase = this.current?.phase ?? null;
		this.generation += 1;
		this.current?.controller.abort();
		this.current = null;
		return phase;
	}
}

export async function sha256Text(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
