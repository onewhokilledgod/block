import { describe, expect, it, vi } from "vitest";

import type { DnrRule } from "../shared/filter-engine.js";
import type {
	DeclarativeNetRequestApi,
	DynamicRulesUpdate,
	ExistingDynamicRule
} from "./browser-api.js";

import { DnrRulesManager } from "./rules-manager.js";

function createRule(id: number): DnrRule {
	return {
		id,
		priority: 100,
		action: { type: "block" },
		condition: {
			urlFilter: `||ads-${id}.example^`,
			resourceTypes: ["script"]
		}
	};
}

function createMockApi(initial: ExistingDynamicRule[] = []) {
	let currentRules = initial.map(({ id }) => ({ id }));

	const getDynamicRules = vi.fn(
		async (): Promise<ExistingDynamicRule[]> =>
			currentRules.map(({ id }) => ({ id }))
	);

	const updateDynamicRules = vi.fn(
		async ({ removeRuleIds, addRules }: DynamicRulesUpdate): Promise<void> => {
			const removed = new Set(removeRuleIds);

			const remaining = currentRules.filter(({ id }) => !removed.has(id));

			const ids = new Set(remaining.map(({ id }) => id));

			for (const rule of addRules) {
				if (ids.has(rule.id)) {
					throw new Error(`Duplicate ID: ${rule.id}`);
				}

				ids.add(rule.id);
			}

			// Apply only after validating the entire update.
			currentRules = [...remaining, ...addRules.map(({ id }) => ({ id }))];
		}
	);
	const isRegexSupported = vi.fn(
		async (): Promise<{ isSupported: boolean; reason?: string }> => ({
			isSupported: true
		})
	);

	const api: DeclarativeNetRequestApi = {
		getDynamicRules,
		updateDynamicRules,
		isRegexSupported
	};

	return {
		api,
		getDynamicRules,
		updateDynamicRules,
		isRegexSupported,
		getCurrentIds: () => currentRules.map(({ id }) => id)
	};
}

describe("DnrRulesManager", () => {
	it("returns only managed IDs in ascending order", async () => {
		const mock = createMockApi([
			{ id: 6000 },
			{ id: 3 },
			{ id: 1 },
			{ id: 5000 }
		]);

		const manager = new DnrRulesManager(mock.api);

		await expect(manager.getManagedRuleIds()).resolves.toEqual([1, 3, 5000]);
	});

	it("replaces managed rules and preserves foreign rules", async () => {
		const mock = createMockApi([{ id: 1 }, { id: 20 }, { id: 6000 }]);

		const manager = new DnrRulesManager(mock.api);
		const rules = [createRule(10), createRule(11)];

		const result = await manager.replaceManagedRules(rules);

		expect(result).toEqual({
			previousManagedCount: 2,
			installedCount: 2,
			preservedDynamicRuleCount: 1
		});

		expect(mock.updateDynamicRules).toHaveBeenCalledWith({
			removeRuleIds: [1, 20],
			addRules: rules
		});

		expect(mock.getCurrentIds().sort((a, b) => a - b)).toEqual([10, 11, 6000]);
	});

	it("clears only managed rules", async () => {
		const mock = createMockApi([{ id: 1 }, { id: 5000 }, { id: 6000 }]);

		const manager = new DnrRulesManager(mock.api);

		const result = await manager.clearManagedRules();

		expect(result.previousManagedCount).toBe(2);
		expect(result.installedCount).toBe(0);

		expect(mock.getCurrentIds()).toEqual([6000]);
	});

	it("delegates regex compatibility checks to the browser", async () => {
		const mock = createMockApi();
		mock.isRegexSupported.mockResolvedValue({
			isSupported: false,
			reason: "syntaxError"
		});
		const manager = new DnrRulesManager(mock.api);

		await expect(
			manager.isRegexSupported("^https?://ads\\.example/", false)
		).resolves.toEqual({ isSupported: false, reason: "syntaxError" });
		expect(mock.isRegexSupported).toHaveBeenCalledWith({
			regex: "^https?://ads\\.example/",
			isCaseSensitive: false,
			requireCapturing: false
		});
	});

	it("rejects duplicate IDs before calling the browser API", async () => {
		const mock = createMockApi();
		const manager = new DnrRulesManager(mock.api);

		await expect(
			manager.replaceManagedRules([createRule(1), createRule(1)])
		).rejects.toThrow("Duplicate DNR rule ID");

		expect(mock.getDynamicRules).not.toHaveBeenCalled();
		expect(mock.updateDynamicRules).not.toHaveBeenCalled();
	});

	it("rejects IDs outside the reserved range", async () => {
		const mock = createMockApi();
		const manager = new DnrRulesManager(mock.api);

		await expect(
			manager.replaceManagedRules([createRule(5001)])
		).rejects.toThrow("outside the managed range");

		expect(mock.updateDynamicRules).not.toHaveBeenCalled();
	});

	it("preserves existing rules when the global limit would be exceeded", async () => {
		const foreignRules = Array.from({ length: 5000 }, (_, index) => ({
			id: 5001 + index
		}));

		const mock = createMockApi(foreignRules);
		const manager = new DnrRulesManager(mock.api);

		await expect(manager.replaceManagedRules([createRule(1)])).rejects.toThrow(
			"cross-browser dynamic rule limit"
		);

		expect(mock.updateDynamicRules).not.toHaveBeenCalled();
	});

	it("continues working after a browser API failure", async () => {
		const mock = createMockApi([{ id: 1 }]);
		const manager = new DnrRulesManager(mock.api);

		vi.spyOn(mock.api, "updateDynamicRules").mockRejectedValueOnce(
			new Error("Simulated DNR failure")
		);

		await expect(manager.replaceManagedRules([createRule(2)])).rejects.toThrow(
			"Simulated DNR failure"
		);

		expect(mock.getCurrentIds()).toEqual([1]);

		await manager.replaceManagedRules([createRule(2)]);

		expect(mock.getCurrentIds()).toEqual([2]);
	});

	it("accepts rules without urlFilter", async () => {
		const mock = createMockApi();
		const manager = new DnrRulesManager(mock.api);

		const rule: DnrRule = {
			id: 10,
			priority: 100,
			action: { type: "block" },
			condition: {
				initiatorDomains: ["mega4upload.net"],
				domainType: "thirdParty",
				resourceTypes: ["xmlhttprequest"]
			}
		};

		const result = await manager.replaceManagedRules([rule]);

		expect(result.installedCount).toBe(1);
		expect(mock.updateDynamicRules).toHaveBeenCalledWith({
			removeRuleIds: [],
			addRules: [rule]
		});
		expect(mock.getCurrentIds()).toEqual([10]);
	});

	it("rejects an empty urlFilter without modifying existing rules", async () => {
		const mock = createMockApi([{ id: 1 }, { id: 6000 }]);
		const manager = new DnrRulesManager(mock.api);

		const rule = createRule(2);
		rule.condition.urlFilter = "";

		await expect(manager.replaceManagedRules([rule])).rejects.toThrow(
			"invalid URL filter"
		);

		expect(mock.getDynamicRules).not.toHaveBeenCalled();
		expect(mock.updateDynamicRules).not.toHaveBeenCalled();
		expect(mock.getCurrentIds()).toEqual([1, 6000]);
	});

	it("rejects rules that specify both URL and regex filters", async () => {
		const mock = createMockApi();
		const manager = new DnrRulesManager(mock.api);
		const rule = createRule(2);
		rule.condition.regexFilter = "^https?://ads\\.example/";

		await expect(manager.replaceManagedRules([rule])).rejects.toThrow(
			"both urlFilter and regexFilter"
		);
		expect(mock.getDynamicRules).not.toHaveBeenCalled();
		expect(mock.updateDynamicRules).not.toHaveBeenCalled();
	});

	it("rejects non-ASCII regex filters before calling the browser API", async () => {
		const mock = createMockApi();
		const manager = new DnrRulesManager(mock.api);
		const rule = createRule(2);
		rule.condition.urlFilter = undefined;
		rule.condition.regexFilter = "^https://café\\.example/";

		await expect(manager.replaceManagedRules([rule])).rejects.toThrow(
			"only ASCII characters"
		);
		expect(mock.getDynamicRules).not.toHaveBeenCalled();
		expect(mock.updateDynamicRules).not.toHaveBeenCalled();
	});
});
