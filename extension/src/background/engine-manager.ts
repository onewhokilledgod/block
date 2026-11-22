import type { CompileReport, FilterEngine } from "../shared/filter-engine.js";
export type { CompileReport };

import {
	FILTER_LISTS,
	getFilterListDefinition,
	type FilterListId
} from "./filter-lists.js";

import { DnrRulesManager, type RulesUpdateResult } from "./rules-manager.js";

export interface FilterApplyResult {
	report: CompileReport;
	update: RulesUpdateResult;
}

export interface FilterListInput {
	id: FilterListId;
	content: string;
}

export interface FilterListCompilation {
	id: FilterListId;
	name: string;
	report: CompileReport;
}

export interface FilterListsApplyResult {
	lists: FilterListCompilation[];
	report: CompileReport;
	update: RulesUpdateResult;
}

export class FilterApplicationError extends Error {
	constructor(
		message: string,
		public readonly report: CompileReport
	) {
		super(message);
		this.name = "FilterApplicationError";
	}
}

function combineReports(
	compilations: readonly FilterListCompilation[]
): CompileReport {
	return {
		rules: compilations.flatMap(item => item.report.rules),

		parserDiagnostics: compilations.flatMap(
			item => item.report.parserDiagnostics
		),

		compilerDiagnostics: compilations.flatMap(
			item => item.report.compilerDiagnostics
		),

		parserStats: compilations.reduce(
			(total, item) => ({
				totalFilters: total.totalFilters + item.report.parserStats.totalFilters,

				networkFilters:
					total.networkFilters + item.report.parserStats.networkFilters,

				cosmeticFilters:
					total.cosmeticFilters + item.report.parserStats.cosmeticFilters,

				errors: total.errors + item.report.parserStats.errors,

				warnings: total.warnings + item.report.parserStats.warnings
			}),
			{
				totalFilters: 0,
				networkFilters: 0,
				cosmeticFilters: 0,
				errors: 0,
				warnings: 0
			}
		),

		compilerStats: compilations.reduce(
			(total, item) => ({
				networkFiltersSeen:
					total.networkFiltersSeen +
					item.report.compilerStats.networkFiltersSeen,

				compiledRules:
					total.compiledRules + item.report.compilerStats.compiledRules,

				skippedNetworkFilters:
					total.skippedNetworkFilters +
					item.report.compilerStats.skippedNetworkFilters,

				cosmeticFiltersDeferred:
					total.cosmeticFiltersDeferred +
					item.report.compilerStats.cosmeticFiltersDeferred,

				regexRules: total.regexRules + item.report.compilerStats.regexRules
			}),
			{
				networkFiltersSeen: 0,
				compiledRules: 0,
				skippedNetworkFilters: 0,
				cosmeticFiltersDeferred: 0,
				regexRules: 0
			}
		)
	};
}

export class FilterEngineManager {
	constructor(
		private readonly engine: FilterEngine,
		private readonly rulesManager: DnrRulesManager
	) {}

	/**
	 * Compiles and applies one standalone ABP list.
	 */
	async applyFilterList(input: string): Promise<FilterApplyResult> {
		if (!input.trim()) {
			throw new TypeError(
				"Filter list must not be empty. " +
					"Use clearManagedRules() to remove rules explicitly."
			);
		}

		const report = this.engine.compileFilterList(input, {
			maxRules: 5000,
			firstRuleId: 1
		});

		this.validateReport(report);

		if (report.rules.length === 0) {
			throw new FilterApplicationError(
				"Filter list produced no supported network rules.",
				report
			);
		}

		const update = await this.rulesManager.replaceManagedRules(report.rules);

		return { report, update };
	}

	/**
	 * Compiles all enabled lists into separate ID ranges
	 * and replaces the managed DNR rules only once.
	 */
	async applyFilterLists(
		inputs: readonly FilterListInput[]
	): Promise<FilterListsApplyResult> {
		if (!Array.isArray(inputs) || inputs.length === 0) {
			throw new TypeError("At least one filter list is required.");
		}

		const inputMap = new Map<FilterListId, string>();

		for (const input of inputs) {
			const definition = getFilterListDefinition(input.id);

			if (!definition.enabledByDefault) {
				throw new Error(`Filter list '${input.id}' is not enabled.`);
			}

			if (inputMap.has(input.id)) {
				throw new Error(`Duplicate filter list: ${input.id}.`);
			}

			if (!input.content.trim()) {
				throw new TypeError(`Filter list '${input.id}' is empty.`);
			}

			inputMap.set(input.id, input.content);
		}

		const requiredLists = FILTER_LISTS.filter(
			definition => definition.enabledByDefault
		);

		const missingLists = requiredLists.filter(
			definition => !inputMap.has(definition.id)
		);

		if (missingLists.length > 0) {
			throw new Error(
				`Missing required filter lists: ${missingLists
					.map(item => item.id)
					.join(", ")}.`
			);
		}

		const compilations: FilterListCompilation[] = [];

		for (const definition of requiredLists) {
			const content = inputMap.get(definition.id)!;

			const report = this.engine.compileFilterList(content, {
				maxRules: definition.ruleBudget,
				firstRuleId: definition.firstRuleId
			});

			const parserErrors = report.parserDiagnostics.filter(
				diagnostic => diagnostic.level === "error"
			);

			const compilerErrors = report.compilerDiagnostics.filter(
				diagnostic => diagnostic.level === "error"
			);

			if (parserErrors.length > 0 || compilerErrors.length > 0) {
				console.error(
					`[Block] Compilation errors in ${definition.id} (${definition.name})`,
					{
						parserStats: report.parserStats,
						compilerStats: report.compilerStats,

						parserErrorsTotal: parserErrors.length,
						compilerErrorsTotal: compilerErrors.length,

						parserErrors: parserErrors.slice(0, 10),
						compilerErrors: compilerErrors.slice(0, 10)
					}
				);
			}

			const lastRuleId = definition.firstRuleId + definition.ruleBudget - 1;

			for (const rule of report.rules) {
				if (rule.id < definition.firstRuleId || rule.id > lastRuleId) {
					throw new FilterApplicationError(
						`List '${definition.id}' produced a rule ` +
							`outside its allocated ID range.`,
						report
					);
				}
			}

			compilations.push({
				id: definition.id,
				name: definition.name,
				report
			});
		}

		const combinedReport = combineReports(compilations);

		this.validateReport(combinedReport);

		if (combinedReport.rules.length === 0) {
			throw new FilterApplicationError(
				"No supported DNR rules were produced.",
				combinedReport
			);
		}

		const update = await this.rulesManager.replaceManagedRules(
			combinedReport.rules
		);

		return {
			lists: compilations,
			report: combinedReport,
			update
		};
	}

	private validateReport(report: CompileReport): void {
		const parserErrors = report.parserDiagnostics.filter(
			diagnostic => diagnostic.level === "error"
		);

		const compilerErrors = report.compilerDiagnostics.filter(
			diagnostic => diagnostic.level === "error"
		);

		if (parserErrors.length > 0 || compilerErrors.length > 0) {
			throw new FilterApplicationError(
				"Filter lists contain compilation errors. " +
					"Existing DNR rules were preserved.",
				report
			);
		}
	}

	async clearManagedRules(): Promise<RulesUpdateResult> {
		return this.rulesManager.clearManagedRules();
	}

	async getManagedRuleIds(): Promise<number[]> {
		return this.rulesManager.getManagedRuleIds();
	}
}
