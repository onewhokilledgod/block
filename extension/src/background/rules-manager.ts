import type { DnrRule } from "../shared/filter-engine.js";

import { getDnrApi, type DeclarativeNetRequestApi } from "./browser-api.js";

export const MANAGED_RULE_ID_MIN = 1;
export const MANAGED_RULE_ID_MAX = 5_000;

export const MAX_MANAGED_RULES = MANAGED_RULE_ID_MAX - MANAGED_RULE_ID_MIN + 1;

const MAX_CROSS_BROWSER_DYNAMIC_RULES = 5_000;

export interface RulesUpdateResult {
	previousManagedCount: number;
	installedCount: number;
	preservedDynamicRuleCount: number;
}

function isManagedRuleId(id: number): boolean {
	return (
		Number.isInteger(id) &&
		id >= MANAGED_RULE_ID_MIN &&
		id <= MANAGED_RULE_ID_MAX
	);
}

/**
 * Validate incoming rules before interacting with the browser API.
 *
 * Invalid input is rejected before existing rules can be removed.
 */
function validateRules(rules: readonly DnrRule[]): void {
	if (!Array.isArray(rules)) {
		throw new TypeError("Rules must be an array.");
	}

	if (rules.length > MAX_MANAGED_RULES) {
		throw new RangeError(
			`Too many rules: ${rules.length}. ` + `Maximum: ${MAX_MANAGED_RULES}.`
		);
	}

	const seenIds = new Set<number>();

	for (const rule of rules) {
		if (!rule || typeof rule !== "object") {
			throw new TypeError("Invalid DNR rule.");
		}

		if (!isManagedRuleId(rule.id)) {
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

		if (
			typeof rule.condition.urlFilter !== "string" ||
			rule.condition.urlFilter.length === 0
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

	/**
	 * Serializes modifications to prevent concurrent replacements.
	 */
	private operationQueue: Promise<void> = Promise.resolve();

	constructor(api: DeclarativeNetRequestApi = getDnrApi()) {
		this.api = api;
	}

	/**
	 * Returns IDs belonging to this manager.
	 */
	async getManagedRuleIds(): Promise<number[]> {
		return this.enqueue(async () => {
			const rules = await this.api.getDynamicRules();

			return rules
				.filter(rule => isManagedRuleId(rule.id))
				.map(rule => rule.id)
				.sort((a, b) => a - b);
		});
	}

	/**
	 * Atomically replaces all managed rules.
	 *
	 * Rules outside the reserved ID range are preserved.
	 */
	replaceManagedRules(rules: readonly DnrRule[]): Promise<RulesUpdateResult> {
		const nextRules = Array.from(rules);

		validateRules(nextRules);

		return this.enqueue(async () => {
			const existingRules = await this.api.getDynamicRules();

			const managedIds = existingRules
				.filter(rule => isManagedRuleId(rule.id))
				.map(rule => rule.id);

			const preservedCount = existingRules.length - managedIds.length;

			if (preservedCount + nextRules.length > MAX_CROSS_BROWSER_DYNAMIC_RULES) {
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
