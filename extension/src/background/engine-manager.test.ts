import { describe, expect, it, vi } from "vitest";

import type {
	CompileOptions,
	CompileReport,
	FilterEngine,
	FilterListCompileInput,
	ParseReport,
	DnrRule
} from "../shared/filter-engine.js";

import type {
	DeclarativeNetRequestApi,
	DynamicRulesUpdate,
	ExistingDynamicRule,
	RegexOptions,
	RegexSupportResult
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

function createRegexRule(
	id: number,
	regexFilter: string,
	isCaseSensitive = false
): DnrRule {
	return {
		id,
		priority: 100,
		action: { type: "block" },
		condition: {
			regexFilter,
			isUrlFilterCaseSensitive: isCaseSensitive,
			resourceTypes: ["script"]
		}
	};
}

function createReport(
	id: number,
	rules: DnrRule[] = [createRule(id)]
): CompileReport {
	return {
		rules,
		parserDiagnostics: [],
		compilerDiagnostics: [],
		parserStats: {
			totalFilters: rules.length,
			networkFilters: rules.length,
			cosmeticFilters: 0,
			errors: 0,
			warnings: 0
		},
		compilerStats: {
			networkFiltersSeen: rules.length,
			compiledRules: rules.length,
			skippedNetworkFilters: 0,
			cosmeticFiltersDeferred: 0,
			regexRules: rules.filter(rule => rule.condition.regexFilter !== undefined).length
		}
	};
}

function createEngine() {
	const compileFilterList = vi.fn((_input: string, options?: CompileOptions) =>
		createReport(options?.firstRuleId ?? 1)
	);
	const compileFilterLists = vi.fn((inputs: FilterListCompileInput[]) =>
		inputs.map(({ content, options }) =>
			compileFilterList(content, options)
		)
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
		compileFilterList,
		compileFilterLists
	};

	return { engine, compileFilterList, compileFilterLists };
}

function createMockRulesApi() {
	let currentRules: ExistingDynamicRule[] = [];

	const updates: DynamicRulesUpdate[] = [];
	const isRegexSupported = vi.fn(
		async (_options: RegexOptions): Promise<RegexSupportResult> => ({
			isSupported: true
		})
	);


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
		},
		isRegexSupported
	};

	return {
		api,
		updates,
		isRegexSupported,
		getCurrentIds: () => currentRules.map(({ id }) => id)
	};
}

describe("FilterEngineManager", () => {
	it("compiles both lists into separate ID ranges", async () => {
		const { engine, compileFilterList, compileFilterLists } = createEngine();
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

		expect(compileFilterLists).toHaveBeenCalledTimes(1);
		expect(compileFilterList).toHaveBeenNthCalledWith(1, "easylist content", {
			maxRules: 3500,
			maxRegexRules: 1000,
			firstRuleId: 1
		});

		expect(compileFilterList).toHaveBeenNthCalledWith(
			2,
			"easyprivacy content",
			{
				maxRules: 1500,
				maxRegexRules: 1000,
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

	it("allocates the larger safe dynamic-rule budget exposed by Chrome", async () => {
		const { engine, compileFilterList } = createEngine();
		const mockApi = createMockRulesApi();
		Object.assign(mockApi.api, {
			MAX_NUMBER_OF_DYNAMIC_RULES: 30_000,
			MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5_000,
			MAX_NUMBER_OF_REGEX_RULES: 1_000
		});

		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api)
		);

		await manager.applyFilterLists([
			{ id: "easylist", content: "easylist content" },
			{ id: "easyprivacy", content: "easyprivacy content" }
		]);

		expect(compileFilterList).toHaveBeenNthCalledWith(1, "easylist content", {
			maxRules: 21_000,
			maxRegexRules: 1_000,
			firstRuleId: 1
		});
		expect(compileFilterList).toHaveBeenNthCalledWith(2, "easyprivacy content", {
			maxRules: 9_000,
			maxRegexRules: 1_000,
			firstRuleId: 21_001
		});
		expect(mockApi.getCurrentIds()).toEqual([1, 21_001]);
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
		const { engine, compileFilterLists } = createEngine();
		const mockApi = createMockRulesApi();

		compileFilterLists.mockImplementation(inputs =>
			inputs.map(({ options }) => {
				const firstRuleId = options?.firstRuleId ?? 1;
				return createReport(firstRuleId + 4000);
			})
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
	it("checks regex rules with the browser and skips unsupported expressions", async () => {
		const { engine, compileFilterList } = createEngine();
		const mockApi = createMockRulesApi();
		const supportedRegex = "^https?://ads\\.example/";
		const unsupportedRegex = "^https?://tracker\\.example/";

		compileFilterList.mockImplementation((_input, options) => {
			const firstRuleId = options?.firstRuleId ?? 1;
			const regex = firstRuleId === 1 ? supportedRegex : unsupportedRegex;
			return createReport(firstRuleId, [
				createRule(firstRuleId),
				createRegexRule(firstRuleId + 1, regex, firstRuleId !== 1)
			]);
		});

		mockApi.isRegexSupported.mockImplementation(async ({ regex }) =>
			regex === supportedRegex
				? { isSupported: true }
				: { isSupported: false, reason: "syntaxError" }
		);

		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api)
		);

		const result = await manager.applyFilterLists([
			{ id: "easylist", content: "easylist content" },
			{ id: "easyprivacy", content: "easyprivacy content" }
		]);

		expect(mockApi.isRegexSupported).toHaveBeenNthCalledWith(1, {
			regex: supportedRegex,
			isCaseSensitive: false,
			requireCapturing: false
		});
		expect(mockApi.isRegexSupported).toHaveBeenNthCalledWith(2, {
			regex: unsupportedRegex,
			isCaseSensitive: true,
			requireCapturing: false
		});
		expect(result.report.rules.map(rule => rule.id)).toEqual([1, 2, 3501]);
		expect(result.report.compilerStats).toMatchObject({
			compiledRules: 3,
			skippedNetworkFilters: 1,
			regexRules: 1
		});
		expect(result.report.compilerDiagnostics).toContainEqual(
			expect.objectContaining({
				line: 0,
				level: "warning",
				code: "unsupportedRegex",
				pattern: unsupportedRegex
			})
		);
		expect(mockApi.updates[0]?.addRules.map(rule => rule.id)).toEqual([
			1, 2, 3501
		]);
	});

	it("checks duplicate regex patterns only once per case-sensitivity mode", async () => {
		const { engine, compileFilterList } = createEngine();
		const mockApi = createMockRulesApi();
		const regex = "^https?://ads\\.example/";

		compileFilterList.mockReturnValue(
			createReport(1, [
				createRegexRule(1, regex),
				createRegexRule(2, regex)
			])
		);

		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api)
		);
		const result = await manager.applyFilterList("regex list");

		expect(mockApi.isRegexSupported).toHaveBeenCalledTimes(1);
		expect(result.report.rules).toHaveLength(2);
		expect(result.report.compilerStats.regexRules).toBe(2);
	});

	it("skips regex rules safely when browser-side regex validation is unavailable", async () => {
		const { engine, compileFilterList } = createEngine();
		const mockApi = createMockRulesApi();
		delete mockApi.api.isRegexSupported;
		const regex = "^https?://ads\\.example/";
		compileFilterList.mockReturnValue(
			createReport(1, [createRule(1), createRegexRule(2, regex)])
		);

		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api)
		);
		const result = await manager.applyFilterList("mixed rules");

		expect(compileFilterList).toHaveBeenCalledWith("mixed rules", {
			maxRules: 5_000,
			maxRegexRules: 0,
			firstRuleId: 1
		});
		expect(mockApi.isRegexSupported).not.toHaveBeenCalled();
		expect(result.report.rules.map(rule => rule.id)).toEqual([1]);
		expect(result.report.compilerDiagnostics).toContainEqual(
			expect.objectContaining({
				level: "warning",
				code: "unsupportedRegex",
				pattern: regex
			})
		);
	});

	it("preserves existing DNR rules when browser regex validation fails", async () => {
		const { engine, compileFilterList } = createEngine();
		const mockApi = createMockRulesApi();

		compileFilterList.mockReturnValue(
			createReport(1, [createRegexRule(1, "^https?://ads\\.example/")])
		);
		mockApi.isRegexSupported.mockRejectedValueOnce(
			new Error("Browser API unavailable")
		);

		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api)
		);

		await expect(manager.applyFilterList("regex list")).rejects.toThrow(
			"Filter lists contain compilation errors"
		);
		expect(mockApi.updates).toHaveLength(0);
	});

	it("does not install more than 1000 regex rules", async () => {
		const { engine, compileFilterList } = createEngine();
		const mockApi = createMockRulesApi();
		const regexRules = Array.from({ length: 1001 }, (_, index) =>
			createRegexRule(
				index + 1,
				`^https?://ads-${index}\\.example/`
			)
		);

		compileFilterList.mockReturnValue(createReport(1, regexRules));

		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api)
		);
		const result = await manager.applyFilterList("large regex list");

		expect(mockApi.isRegexSupported).toHaveBeenCalledTimes(1000);
		expect(result.report.rules).toHaveLength(1000);
		expect(result.report.compilerStats).toMatchObject({
			compiledRules: 1000,
			skippedNetworkFilters: 1,
			regexRules: 1000
		});
		expect(mockApi.getCurrentIds()).toHaveLength(1000);
	});

	it("passes URL-modification permission to the Rust/WASM compiler", async () => {
		const { engine, compileFilterLists } = createEngine();
		const mockApi = createMockRulesApi();
		const permissions = { contains: vi.fn(async () => true) };
		const manager = new FilterEngineManager(
			engine,
			new DnrRulesManager(mockApi.api, undefined, permissions)
		);

		await manager.applyFilterLists([
			{ id: "easylist", content: "easylist content" },
			{ id: "easyprivacy", content: "easyprivacy content" }
		]);

		expect(compileFilterLists).toHaveBeenCalledWith([
			expect.objectContaining({
				content: "easylist content",
				options: expect.objectContaining({ allowUrlModification: true })
			}),
			expect.objectContaining({
				content: "easyprivacy content",
				options: expect.objectContaining({ allowUrlModification: true })
			})
		]);
	});
});
