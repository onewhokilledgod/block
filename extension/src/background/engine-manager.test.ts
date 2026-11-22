import { describe, expect, it, vi } from "vitest";

import type {
	CompileOptions,
	CompileReport,
	FilterEngine,
	ParseReport,
	DnrRule
} from "../shared/filter-engine.js";

import type {
	DeclarativeNetRequestApi,
	DynamicRulesUpdate,
	ExistingDynamicRule
} from "./browser-api.js";

import { DnrRulesManager } from "./rules-manager.js";
import { FilterEngineManager } from "./engine-manager.js";

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

function createReport(id: number): CompileReport {
	return {
		rules: [createRule(id)],
		parserDiagnostics: [],
		compilerDiagnostics: [],
		parserStats: {
			totalFilters: 1,
			networkFilters: 1,
			cosmeticFilters: 0,
			errors: 0,
			warnings: 0
		},
		compilerStats: {
			networkFiltersSeen: 1,
			compiledRules: 1,
			skippedNetworkFilters: 0,
			cosmeticFiltersDeferred: 0,
			regexRules: 0
		}
	};
}

function createEngine() {
	const compileFilterList = vi.fn((_input: string, options?: CompileOptions) =>
		createReport(options?.firstRuleId ?? 1)
	);

	const engine: FilterEngine = {
		parseFilterList: vi.fn(
			(): ParseReport => ({
				filters: [],
				diagnostics: [],
				stats: {
					totalFilters: 0,
					networkFilters: 0,
					cosmeticFilters: 0,
					errors: 0,
					warnings: 0
				}
			})
		),
		compileFilterList
	};

	return { engine, compileFilterList };
}

function createMockRulesApi() {
	let currentRules: ExistingDynamicRule[] = [];

	const updates: DynamicRulesUpdate[] = [];

	const api: DeclarativeNetRequestApi = {
		getDynamicRules: async () => currentRules.map(({ id }) => ({ id })),

		updateDynamicRules: async update => {
			updates.push(update);

			const removed = new Set(update.removeRuleIds);

			const remaining = currentRules.filter(({ id }) => !removed.has(id));

			currentRules = [
				...remaining,
				...update.addRules.map(({ id }) => ({ id }))
			];
		}
	};

	return {
		api,
		updates,
		getCurrentIds: () => currentRules.map(({ id }) => id)
	};
}

describe("FilterEngineManager", () => {
	it("compiles both lists into separate ID ranges", async () => {
		const { engine, compileFilterList } = createEngine();
		const mockApi = createMockRulesApi();

		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api)
		);

		const result = await manager.applyFilterLists([
			{
				id: "easylist",
				content: "easylist content"
			},
			{
				id: "easyprivacy",
				content: "easyprivacy content"
			}
		]);

		expect(compileFilterList).toHaveBeenNthCalledWith(1, "easylist content", {
			maxRules: 3500,
			firstRuleId: 1
		});

		expect(compileFilterList).toHaveBeenNthCalledWith(
			2,
			"easyprivacy content",
			{
				maxRules: 1500,
				firstRuleId: 3501
			}
		);

		expect(result.report.rules.map(rule => rule.id)).toEqual([1, 3501]);

		expect(result.report.compilerStats.compiledRules).toBe(2);

		// Both lists must be installed in one operation.
		expect(mockApi.updates).toHaveLength(1);

		expect(mockApi.updates[0].addRules).toHaveLength(2);

		expect(mockApi.getCurrentIds().sort((a, b) => a - b)).toEqual([1, 3501]);
	});

	it("rejects missing required lists", async () => {
		const { engine, compileFilterList } = createEngine();
		const mockApi = createMockRulesApi();

		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api)
		);

		await expect(
			manager.applyFilterLists([
				{
					id: "easylist",
					content: "easylist content"
				}
			])
		).rejects.toThrow("Missing required filter lists");

		expect(compileFilterList).not.toHaveBeenCalled();
		expect(mockApi.updates).toHaveLength(0);
	});

	it("rejects duplicate list inputs", async () => {
		const { engine, compileFilterList } = createEngine();
		const mockApi = createMockRulesApi();

		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api)
		);

		await expect(
			manager.applyFilterLists([
				{ id: "easylist", content: "first" },
				{ id: "easylist", content: "second" }
			])
		).rejects.toThrow("Duplicate filter list");

		expect(compileFilterList).not.toHaveBeenCalled();
		expect(mockApi.updates).toHaveLength(0);
	});

	it("does not install rules outside their allocated ID range", async () => {
		const { engine } = createEngine();
		const mockApi = createMockRulesApi();

		engine.compileFilterList = vi.fn(
			(_input: string, options?: CompileOptions) => {
				const firstRuleId = options?.firstRuleId ?? 1;

				return createReport(firstRuleId + 4000);
			}
		);

		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api)
		);

		await expect(
			manager.applyFilterLists([
				{ id: "easylist", content: "easylist" },
				{ id: "easyprivacy", content: "easyprivacy" }
			])
		).rejects.toThrow("outside its allocated ID range");

		expect(mockApi.updates).toHaveLength(0);
	});
});
