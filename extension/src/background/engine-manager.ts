import type { CompileReport, FilterEngine } from "../shared/filter-engine.js";

import {
	DnrRulesManager,
	MANAGED_RULE_ID_MIN,
	MAX_MANAGED_RULES,
	type RulesUpdateResult
} from "./rules-manager.js";

export interface FilterApplyResult {
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

export class FilterEngineManager {
	constructor(
		private readonly engine: FilterEngine,
		private readonly rulesManager: DnrRulesManager
	) {}

	/**
	 * Compiles an ABP filter list and atomically installs
	 * the resulting DNR rules.
	 */
	async applyFilterList(input: string): Promise<FilterApplyResult> {
		if (!input.trim()) {
			throw new TypeError(
				"Filter list must not be empty. " +
					"Use clearManagedRules() to remove rules explicitly."
			);
		}

		const report = this.engine.compileFilterList(input, {
			maxRules: MAX_MANAGED_RULES,
			firstRuleId: MANAGED_RULE_ID_MIN
		});

		const parserErrors = report.parserDiagnostics.filter(
			diagnostic => diagnostic.level === "error"
		);

		const compilerErrors = report.compilerDiagnostics.filter(
			diagnostic => diagnostic.level === "error"
		);

		if (parserErrors.length > 0 || compilerErrors.length > 0) {
			throw new FilterApplicationError(
				"Filter list contains errors and was not applied.",
				report
			);
		}

		if (report.rules.length === 0) {
			throw new FilterApplicationError(
				"Filter list produced no supported network rules. " +
					"Existing rules were preserved.",
				report
			);
		}

		const update = await this.rulesManager.replaceManagedRules(report.rules);

		return {
			report,
			update
		};
	}

	/**
	 * Explicitly removes all rules managed by Block.
	 */
	async clearManagedRules(): Promise<RulesUpdateResult> {
		return this.rulesManager.clearManagedRules();
	}

	async getManagedRuleIds(): Promise<number[]> {
		return this.rulesManager.getManagedRuleIds();
	}
}
