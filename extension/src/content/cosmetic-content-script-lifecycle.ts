export interface CosmeticContentScriptLifecycleState {
	/** True only after CSS was successfully applied to the current document. */
	__blockCosmeticContentScriptReady?: boolean;
	/** Shared promise used to coalesce concurrent injections in one document. */
	__blockCosmeticContentScriptPromise?: Promise<void>;
}

/**
 * Starts cosmetic filtering once per document and coalesces concurrent calls.
 *
 * An unsuccessful or empty attempt does not permanently mark the document as
 * initialized. A later executeScript() call can therefore retry after a
 * transient messaging/API failure or after cosmetic rules become available.
 */
export function startCosmeticContentScript(
	state: CosmeticContentScriptLifecycleState,
	initialize: () => Promise<boolean>,
	onError: (error: unknown) => void
): void {
	if (
		state.__blockCosmeticContentScriptReady ||
		state.__blockCosmeticContentScriptPromise
	) {
		return;
	}

	const pending = Promise.resolve()
		.then(initialize)
		.then(applied => {
			if (applied) {
				state.__blockCosmeticContentScriptReady = true;
			}
		})
		.catch(onError);

	state.__blockCosmeticContentScriptPromise = pending;

	const clearPending = (): void => {
		if (state.__blockCosmeticContentScriptPromise === pending) {
			state.__blockCosmeticContentScriptPromise = undefined;
		}
	};

	// Handle both branches so the cleanup chain itself cannot reject.
	void pending.then(clearPending, clearPending);
}
