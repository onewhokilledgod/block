import type { DnrRule } from "../shared/filter-engine.js";

import { getDnrApi, type DeclarativeNetRequestApi } from "./browser-api.js";
import type { RegexSupportResult } from "./browser-api.js";
import {
	detectBrowserCapabilities,
	type BrowserCapabilities
} from "./browser-capabilities.js";

export const MANAGED_RULE_ID_MIN = 1;

export interface RulesUpdateResult {
	previousManagedCount: number;
	installedCount: number;
	preservedDynamicRuleCount: number;
}

function isManagedRuleId(id: number, managedRuleIdMax: number): boolean {
	return (
		Number.isInteger(id) &&
		id >= MANAGED_RULE_ID_MIN &&
		id <= managedRuleIdMax
	);
}

/**
 * Validate incoming rules before interacting with the browser API.
 *
 * Invalid input is rejected before existing rules can be removed.
 */
function validateRules(
	rules: readonly DnrRule[],
	managedRuleIdMax: number
): void {
	if (!Array.isArray(rules)) {
		throw new TypeError("Rules must be an array.");
	}

	if (rules.length > managedRuleIdMax) {
		throw new RangeError(
			`Too many rules: ${rules.length}. ` + `Maximum: ${managedRuleIdMax}.`
		);
	}

	const seenIds = new Set<number>();

	for (const rule of rules) {
		if (!rule || typeof rule !== "object") {
			throw new TypeError("Invalid DNR rule.");
		}

		if (!isManagedRuleId(rule.id, managedRuleIdMax)) {
			throw new RangeError(`Rule ID ${rule.id} is outside the managed range.`);
		}

		if (seenIds.has(rule.id)) {
			throw new Error(`Duplicate DNR rule ID: ${rule.id}.`);
		}

		seenIds.add(rule.id);

		if (!Number.isInteger(rule.priority) || rule.priority < 1) {
			throw new RangeError(`Invalid priority for rule ${rule.id}.`);
		}

		if (rule.action.type !== "block" && rule.action.type !== "allow") {
			throw new TypeError(`Unsupported action for rule ${rule.id}.`);
		}

		if (!rule.condition || typeof rule.condition !== "object") {
			throw new TypeError(`Rule ${rule.id} has an invalid condition.`);
		}

		const urlFilter = rule.condition.urlFilter;
		const regexFilter = rule.condition.regexFilter;

		if (urlFilter !== undefined && regexFilter !== undefined) {
			throw new TypeError(
				`Rule ${rule.id} cannot specify both urlFilter and regexFilter.`
			);
		}

		if (
			regexFilter !== undefined &&
			(typeof regexFilter !== "string" || regexFilter.length === 0)
		) {
			throw new TypeError(`Rule ${rule.id} has an invalid regex filter.`);
		}

		if (regexFilter !== undefined && /[^\x00-\x7F]/.test(regexFilter)) {
			throw new TypeError(
				`Rule ${rule.id} regex filter must contain only ASCII characters.`
			);
		}

		if (
			urlFilter !== undefined &&
			(typeof urlFilter !== "string" || urlFilter.length === 0)
		) {
			throw new TypeError(`Rule ${rule.id} has an invalid URL filter.`);
		}

		if (
			!Array.isArray(rule.condition.resourceTypes) ||
			rule.condition.resourceTypes.length === 0
		) {
			throw new TypeError(`Rule ${rule.id} must specify resource types.`);
		}

		if (
			!rule.condition.resourceTypes.every(
				(resourceType: unknown) => typeof resourceType === "string"
			)
		) {
			throw new TypeError(`Rule ${rule.id} has invalid resource types.`);
		}
	}
}

export class DnrRulesManager {
	private readonly api: DeclarativeNetRequestApi;
	readonly capabilities: BrowserCapabilities;
	private readonly managedRuleIdMax: number;

	/**
	 * Serializes modifications to prevent concurrent replacements.
	 */
	private operationQueue: Promise<void> = Promise.resolve();

	constructor(
		api: DeclarativeNetRequestApi = getDnrApi(),
		capabilities: BrowserCapabilities = detectBrowserCapabilities(api)
	) {
		this.api = api;
		this.capabilities = capabilities;
		this.managedRuleIdMax = Math.min(
			capabilities.maxDynamicRules,
			capabilities.maxRuleId
		);
	}

	/**
	 * Checks a regex with the browser's RE2 implementation before installation.
	 */
	isRegexSupported(
		regex: string,
		isCaseSensitive: boolean
	): Promise<RegexSupportResult> {
		const check = this.api.isRegexSupported;
		if (!check) {
			throw new Error(
				"The browser does not expose declarativeNetRequest.isRegexSupported()."
			);
		}

		return check.call(this.api, {
			regex,
			isCaseSensitive,
			requireCapturing: false
		});
	}

	/**
	 * Returns IDs belonging to this manager.
	 */
	async getManagedRuleIds(): Promise<number[]> {
		return this.enqueue(async () => {
			const rules = await this.api.getDynamicRules();

			return rules
				.filter(rule =>
					isManagedRuleId(rule.id, this.managedRuleIdMax)
				)
				.map(rule => rule.id)
				.sort((a, b) => a - b);
		});
	}

	/**
	 * Returns the rule count available to the managed ID range after preserving
	 * dynamic rules owned by other modules of this extension.
	 */
	getAvailableManagedRuleCapacity(): Promise<number> {
		return this.enqueue(async () => {
			const existingRules = await this.api.getDynamicRules();
			const preservedCount = existingRules.filter(
				rule => !isManagedRuleId(rule.id, this.managedRuleIdMax)
			).length;

			return Math.max(
				0,
				Math.min(
					this.managedRuleIdMax,
					this.capabilities.maxDynamicRules - preservedCount
				)
			);
		});
	}

	/**
	 * Atomically replaces all managed rules.
	 *
	 * Rules outside the reserved ID range are preserved.
	 */
	replaceManagedRules(rules: readonly DnrRule[]): Promise<RulesUpdateResult> {
		const nextRules = Array.from(rules);

		return this.enqueue(async () => {
			validateRules(nextRules, this.managedRuleIdMax);

			const existingRules = await this.api.getDynamicRules();

			const managedIds = existingRules
				.filter(rule =>
					isManagedRuleId(rule.id, this.managedRuleIdMax)
				)
				.map(rule => rule.id);

			const preservedCount = existingRules.length - managedIds.length;

			if (
				preservedCount + nextRules.length >
				this.capabilities.maxDynamicRules
			) {
				throw new RangeError(
					"The cross-browser dynamic rule limit would be exceeded."
				);
			}

			await this.api.updateDynamicRules({
				removeRuleIds: managedIds,
				addRules: nextRules
			});

			return {
				previousManagedCount: managedIds.length,
				installedCount: nextRules.length,
				preservedDynamicRuleCount: preservedCount
			};
		});
	}

	/**
	 * Removes all rules owned by this manager.
	 */
	clearManagedRules(): Promise<RulesUpdateResult> {
		return this.replaceManagedRules([]);
	}

	/**
	 * Runs operations sequentially.
	 *
	 * A rejected operation does not permanently block the queue.
	 */
	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationQueue.then(operation, operation);

		this.operationQueue = result.then(
			() => undefined,
			() => undefined
		);

		return result;
	}
}
