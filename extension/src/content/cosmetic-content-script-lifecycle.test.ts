import { describe, expect, it, vi } from "vitest";

import {
	startCosmeticContentScript,
	type CosmeticContentScriptLifecycleState
} from "./cosmetic-content-script-lifecycle.js";

function createState(): CosmeticContentScriptLifecycleState {
	return {};
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;

	const promise = new Promise<T>(resolvePromise => {
		resolve = resolvePromise;
	});

	return { promise, resolve };
}

describe("startCosmeticContentScript", () => {
	it("coalesces concurrent calls and remembers successful initialization", async () => {
		const state = createState();
		const deferred = createDeferred<boolean>();
		const initialize = vi.fn(() => deferred.promise);
		const onError = vi.fn();

		startCosmeticContentScript(state, initialize, onError);
		const firstAttempt = state.__blockCosmeticContentScriptPromise;

		startCosmeticContentScript(state, initialize, onError);

		expect(initialize).not.toHaveBeenCalled();
		expect(firstAttempt).toBeDefined();

		deferred.resolve(true);
		await firstAttempt;

		expect(initialize).toHaveBeenCalledOnce();
		expect(state.__blockCosmeticContentScriptReady).toBe(true);
		expect(state.__blockCosmeticContentScriptPromise).toBeUndefined();
		expect(onError).not.toHaveBeenCalled();

		startCosmeticContentScript(state, initialize, onError);
		await Promise.resolve();
		expect(initialize).toHaveBeenCalledOnce();
	});

	it("allows another attempt when no CSS was applied", async () => {
		const state = createState();
		const initialize = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const onError = vi.fn();

		startCosmeticContentScript(state, initialize, onError);
		await state.__blockCosmeticContentScriptPromise;

		expect(state.__blockCosmeticContentScriptReady).toBeUndefined();
		expect(state.__blockCosmeticContentScriptPromise).toBeUndefined();

		startCosmeticContentScript(state, initialize, onError);
		await state.__blockCosmeticContentScriptPromise;

		expect(initialize).toHaveBeenCalledTimes(2);
		expect(state.__blockCosmeticContentScriptReady).toBe(true);
	});

	it("clears a rejected attempt and allows retry", async () => {
		const state = createState();
		const error = new Error("Temporary runtime messaging failure");
		const initialize = vi
			.fn<() => Promise<boolean>>()
			.mockRejectedValueOnce(error)
			.mockResolvedValueOnce(true);
		const onError = vi.fn();

		startCosmeticContentScript(state, initialize, onError);
		await state.__blockCosmeticContentScriptPromise;

		expect(onError).toHaveBeenCalledWith(error);
		expect(state.__blockCosmeticContentScriptReady).toBeUndefined();
		expect(state.__blockCosmeticContentScriptPromise).toBeUndefined();

		startCosmeticContentScript(state, initialize, onError);
		await state.__blockCosmeticContentScriptPromise;

		expect(initialize).toHaveBeenCalledTimes(2);
		expect(state.__blockCosmeticContentScriptReady).toBe(true);
	});

	it("also clears the in-flight state after a synchronous initialization error", async () => {
		const state = createState();
		const error = new Error("Synchronous initialization failure");
		const initialize = vi.fn<() => Promise<boolean>>(() => {
			throw error;
		});
		const onError = vi.fn();

		startCosmeticContentScript(state, initialize, onError);
		await state.__blockCosmeticContentScriptPromise;

		expect(onError).toHaveBeenCalledWith(error);
		expect(state.__blockCosmeticContentScriptPromise).toBeUndefined();
		expect(state.__blockCosmeticContentScriptReady).toBeUndefined();
	});
});
