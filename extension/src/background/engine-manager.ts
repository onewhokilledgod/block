import type {
	CompilerDiagnostic,
	CompileReport,
	DnrRule,
	FilterEngine
} from "../shared/filter-engine.js";
import type { RegexSupportResult } from "./browser-api.js";
import { allocateFilterListRuleRanges } from "./rule-id-allocator.js";
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

const REGEX_CHECK_BATCH_SIZE = 16;


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

		const availableRuleCapacity =
			await this.rulesManager.getAvailableManagedRuleCapacity();
		const regexRuleLimit = this.getRegexRuleLimit();
		const report = this.engine.compileFilterList(input, {
			maxRules: availableRuleCapacity,
			maxRegexRules: regexRuleLimit,
			firstRuleId: 1
		});

		this.validateReport(report);
		const validatedReport = await this.validateRegexRules(
			report,
			regexRuleLimit,
			new Map()
		);
		this.validateReport(validatedReport);

		if (validatedReport.rules.length === 0) {
			throw new FilterApplicationError(
				"Filter list produced no supported network rules.",
				validatedReport
			);
		}

		const update = await this.rulesManager.replaceManagedRules(
			validatedReport.rules
		);

		return { report: validatedReport, update };
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

		const availableRuleCapacity =
			await this.rulesManager.getAvailableManagedRuleCapacity();
		const allocations = allocateFilterListRuleRanges(
			requiredLists,
			availableRuleCapacity,
			this.rulesManager.capabilities.maxRuleId
		);
		const allocationById = new Map(
			allocations.map(allocation => [allocation.id, allocation])
		);
		const regexRuleLimit = this.getRegexRuleLimit();
		const compileInputs = requiredLists.map(definition => {
			const allocation = allocationById.get(definition.id)!;
			return {
				content: inputMap.get(definition.id)!,
				options: {
					maxRules: allocation.maxRules,
					maxRegexRules: regexRuleLimit,
					firstRuleId: allocation.firstRuleId
				}
			};
		});
		const reports = this.engine.compileFilterLists(compileInputs);

		if (reports.length !== requiredLists.length) {
			throw new Error(
				"Filter engine returned an unexpected number of batch compilation reports."
			);
		}

		const compilations: FilterListCompilation[] = [];

		for (const [index, definition] of requiredLists.entries()) {
			const report = reports[index]!;

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

			const allocation = allocationById.get(definition.id)!;
			const lastRuleId =
				allocation.firstRuleId + allocation.maxRules - 1;

			for (const rule of report.rules) {
				if (
					rule.id < allocation.firstRuleId ||
					rule.id > lastRuleId
				) {
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

		const compiledReport = combineReports(compilations);
		this.validateReport(compiledReport);

		const regexSupportCache = new Map<string, RegexSupportResult>();
		let remainingRegexRuleQuota = regexRuleLimit;

		for (let index = 0; index < compilations.length; index += 1) {
			const compilation = compilations[index]!;
			const report = await this.validateRegexRules(
				compilation.report,
				remainingRegexRuleQuota,
				regexSupportCache
			);

			compilations[index] = { ...compilation, report };
			remainingRegexRuleQuota -= report.compilerStats.regexRules;

			if (
				report.compilerDiagnostics.some(
					diagnostic => diagnostic.level === "error"
				)
			) {
				break;
			}
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

	private getRegexRuleLimit(): number {
		return this.rulesManager.capabilities.features.regexValidation
			? this.rulesManager.capabilities.maxRegexRules
			: 0;
	}

	/**
	 * Validates compiled regex rules with the browser before DNR installation.
	 * Checks are deduplicated and bounded to avoid unbounded browser API work.
	 */
	private async validateRegexRules(
		report: CompileReport,
		remainingRegexRuleQuota: number,
		cache: Map<string, RegexSupportResult>
	): Promise<CompileReport> {
		const regexChecks = new Map<
			string,
			{ regex: string; isCaseSensitive: boolean }
		>();
		const keyByRuleId = new Map<number, string>();
		const quotaSkippedRuleIds = new Set<number>();

		for (const rule of report.rules) {
			const regex = rule.condition.regexFilter;
			if (regex === undefined) {
				continue;
			}

			if (keyByRuleId.size >= remainingRegexRuleQuota) {
				quotaSkippedRuleIds.add(rule.id);
				continue;
			}

			const isCaseSensitive =
				rule.condition.isUrlFilterCaseSensitive ?? false;
			const key = JSON.stringify([regex, isCaseSensitive]);
			keyByRuleId.set(rule.id, key);
			if (!cache.has(key)) {
				regexChecks.set(key, { regex, isCaseSensitive });
			}
		}

		const checks = Array.from(regexChecks.entries());
		for (
			let offset = 0;
			offset < checks.length;
			offset += REGEX_CHECK_BATCH_SIZE
		) {
			const batch = checks.slice(offset, offset + REGEX_CHECK_BATCH_SIZE);
			const outcomes = await Promise.all(
				batch.map(async ([key, check]) => {
					try {
						return {
							key,
							result: await this.rulesManager.isRegexSupported(
								check.regex,
								check.isCaseSensitive
							)
						};
					} catch (error: unknown) {
						return { key, error };
					}
				})
			);

			const failed = outcomes.find(outcome => "error" in outcome);
			if (failed && "error" in failed) {
				const check = regexChecks.get(failed.key)!;
				const message =
					failed.error instanceof Error
						? failed.error.message
						: String(failed.error);

				return {
					...report,
					compilerDiagnostics: [
						...report.compilerDiagnostics,
						{
							line: 0,
							level: "error",
							code: "unsupportedRegex",
							message: `Browser regex validation failed: ${message}`,
							pattern: check.regex
						}
					]
				};
			}

			for (const outcome of outcomes) {
				if ("result" in outcome && outcome.result !== undefined) {
					cache.set(outcome.key, outcome.result);
				}
			}
		}

		const rules: DnrRule[] = [];
		const diagnostics: CompilerDiagnostic[] = [];
		let skippedRegexCount = 0;
		let installedRegexCount = 0;

		for (const rule of report.rules) {
			const regex = rule.condition.regexFilter;
			if (regex === undefined) {
				rules.push(rule);
				continue;
			}

			if (quotaSkippedRuleIds.has(rule.id)) {
				skippedRegexCount += 1;
				diagnostics.push({
					line: 0,
					level: "warning",
					code: "unsupportedRegex",
					message:
						`The browser regex rule limit (${this.getRegexRuleLimit()}) ` +
						"has been reached; this rule was skipped.",
					pattern: regex
				});
				continue;
			}

			const key = keyByRuleId.get(rule.id);
			const result = key ? cache.get(key) : undefined;
			if (result?.isSupported) {
				rules.push(rule);
				installedRegexCount += 1;
				continue;
			}

			skippedRegexCount += 1;
			diagnostics.push({
				line: 0,
				level: "warning",
				code: "unsupportedRegex",
				message: result?.reason
					? `The browser rejected this regexFilter: ${result.reason}.`
					: "The browser rejected this regexFilter.",
				pattern: regex
			});
		}

		return {
			...report,
			rules,
			compilerDiagnostics: [
				...report.compilerDiagnostics,
				...diagnostics
			],
			compilerStats: {
				...report.compilerStats,
				compiledRules: Math.max(
					0,
					report.compilerStats.compiledRules - skippedRegexCount
				),
				skippedNetworkFilters:
					report.compilerStats.skippedNetworkFilters + skippedRegexCount,
				regexRules: installedRegexCount
			}
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
