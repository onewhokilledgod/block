import { describe, expect, it, vi } from "vitest";

import type {
	CosmeticFilter,
	FilterEngine
} from "../shared/filter-engine.js";
import {
	APPLY_COSMETIC_CSS_MESSAGE,
	GET_COSMETIC_SELECTORS_MESSAGE
} from "../shared/cosmetic-messages.js";

import type {
	BrowserContentApi,
	BrowserMessageSender,
	RuntimeMessageListener
} from "../shared/browser-content-api.js";
import {
	CosmeticContentRuntime,
	type CosmeticContentServices
} from "./cosmetic-content-runtime.js";

function cosmeticFilter(
	selector: string,
	domains: CosmeticFilter["domains"] = []
): CosmeticFilter {
	return {
		kind: "cosmetic",
		domains,
		selector,
		exception: false,
		sourceLine: 1
	};
}

function createHarness() {
	let listener: RuntimeMessageListener | undefined;

	const runtime = {
		sendMessage: vi.fn(async () => undefined),
		onMessage: {
			addListener: vi.fn((next: RuntimeMessageListener) => {
				listener = next;
			})
		}
	};
	const permissions = {
		request: vi.fn(async () => true),
		contains: vi.fn(async () => true)
	};
	const scripting = {
		getRegisteredContentScripts: vi.fn(async () => []),
		registerContentScripts: vi.fn(async () => undefined),
		updateContentScripts: vi.fn(async () => undefined),
		executeScript: vi.fn(async () => []),
		insertCSS: vi.fn(async () => undefined)
	};

	const api = {
		runtime,
		permissions,
		scripting
	} as unknown as Pick<
		BrowserContentApi,
		"runtime" | "permissions" | "scripting"
	>;

	const activeLists = [
		{ id: "easylist", sha256: "hash-one", content: "generic" },
		{ id: "privacy", sha256: "hash-two", content: "site-specific" }
	];
	const storage = {
		getAllActive: vi.fn(async () => activeLists)
	};
	const filterEngine = {
		parseFilterList: vi.fn((content: string) => ({
			filters:
				content === "generic"
					? [cosmeticFilter(".generic-ad")]
					: [
							cosmeticFilter(".site-ad", [
								{ domain: "example.com", include: true }
							])
						]
		}))
	} as unknown as Pick<FilterEngine, "parseFilterList">;

	const services: CosmeticContentServices = {
		storage: storage as unknown as CosmeticContentServices["storage"],
		filterEngine
	};
	const getServices = vi.fn(async () => services);
	const contentRuntime = new CosmeticContentRuntime(getServices, api);
	contentRuntime.registerListeners();

	function dispatch(
		message: unknown,
		sender: BrowserMessageSender = {
			tab: { id: 7 },
			frameId: 0,
			url: "https://news.example.com/article"
		}
	): Promise<unknown> {
		if (!listener) {
			throw new Error("Message listener was not registered.");
		}

		return new Promise(resolve => {
			const keepChannelOpen = listener!(message, sender, resolve);
			expect(keepChannelOpen).toBe(true);
		});
	}

	return {
		api,
		permissions,
		scripting,
		storage,
		filterEngine,
		getServices,
		dispatch,
		runtime,
		contentRuntime,
		activeLists
	};
}

describe("CosmeticContentRuntime", () => {
	it("returns generic and matching domain-specific selectors", async () => {
		const harness = createHarness();

		await expect(
			harness.dispatch({ type: GET_COSMETIC_SELECTORS_MESSAGE })
		).resolves.toEqual({
			ok: true,
			selectors: [".generic-ad", ".site-ad"]
		});

		expect(harness.storage.getAllActive).toHaveBeenCalledOnce();
		expect(harness.filterEngine.parseFilterList).toHaveBeenCalledTimes(2);
	});

	it("reuses the parsed cosmetic engine until an active list changes", async () => {
		const harness = createHarness();

		await harness.dispatch({ type: GET_COSMETIC_SELECTORS_MESSAGE });
		await harness.dispatch({ type: GET_COSMETIC_SELECTORS_MESSAGE });

		expect(harness.filterEngine.parseFilterList).toHaveBeenCalledTimes(2);

		harness.activeLists[0]!.sha256 = "updated-hash";
		await harness.dispatch({ type: GET_COSMETIC_SELECTORS_MESSAGE });

		expect(harness.filterEngine.parseFilterList).toHaveBeenCalledTimes(4);
	});

	it("does not expose selectors to an unprivileged origin", async () => {
		const harness = createHarness();
		harness.permissions.contains.mockResolvedValue(false);

		await expect(
			harness.dispatch({ type: GET_COSMETIC_SELECTORS_MESSAGE })
		).resolves.toEqual({ ok: true, selectors: [] });

		expect(harness.getServices).not.toHaveBeenCalled();
	});

	it("ignores messages from subframes", async () => {
		const harness = createHarness();

		await expect(
			harness.dispatch(
				{ type: GET_COSMETIC_SELECTORS_MESSAGE },
				{
					tab: { id: 7 },
					frameId: 2,
					url: "https://news.example.com/frame"
				}
			)
		).resolves.toEqual({ ok: true, selectors: [] });

		expect(harness.permissions.contains).not.toHaveBeenCalled();
	});

	it("inserts validated CSS into the originating top-level tab", async () => {
		const harness = createHarness();
		const cssText = ".ad { display: none !important; }";

		await expect(
			harness.dispatch({
				type: APPLY_COSMETIC_CSS_MESSAGE,
				cssText
			})
		).resolves.toEqual({ ok: true });

		expect(harness.scripting.insertCSS).toHaveBeenCalledWith({
			target: { tabId: 7, frameIds: [0] },
			css: cssText,
			origin: "USER"
		});
	});

	it("rejects empty or oversized CSS payloads", async () => {
		const harness = createHarness();

		await expect(
			harness.dispatch({ type: APPLY_COSMETIC_CSS_MESSAGE, cssText: "" })
		).resolves.toMatchObject({ ok: false });

		await expect(
			harness.dispatch({
				type: APPLY_COSMETIC_CSS_MESSAGE,
				cssText: "x".repeat(16_000_001)
			})
		).resolves.toMatchObject({ ok: false });

		expect(harness.scripting.insertCSS).not.toHaveBeenCalled();
	});

	it("does not apply CSS when site access has been revoked", async () => {
		const harness = createHarness();
		harness.permissions.contains.mockResolvedValue(false);

		await expect(
			harness.dispatch({
				type: APPLY_COSMETIC_CSS_MESSAGE,
				cssText: ".ad { display: none !important; }"
			})
		).resolves.toMatchObject({ ok: false });

		expect(harness.scripting.insertCSS).not.toHaveBeenCalled();
	});

	it("registers its runtime listener only once", () => {
		const harness = createHarness();

		harness.contentRuntime.registerListeners();

		expect(harness.runtime.onMessage.addListener).toHaveBeenCalledOnce();
	});
});
