import { MAX_DNR_RULE_ID } from "./browser-capabilities.js";
import type { FilterListDefinition } from "./filter-lists.js";

export interface FilterListRuleAllocation {
	id: FilterListDefinition["id"];
	firstRuleId: number;
	maxRules: number;
}

/**
 * Splits the currently available rule capacity between lists by configured
 * integer weights. Largest-remainder rounding is deterministic and preserves
 * the list order when two remainders are equal.
 */
export function allocateFilterListRuleRanges(
	definitions: readonly FilterListDefinition[],
	capacity: number,
	maxRuleId = MAX_DNR_RULE_ID
): FilterListRuleAllocation[] {
	if (!Array.isArray(definitions) || definitions.length === 0) {
		throw new TypeError("At least one filter list is required for allocation.");
	}

	if (!Number.isSafeInteger(capacity) || capacity < 0) {
		throw new RangeError("Rule capacity must be a non-negative safe integer.");
	}

	if (
		!Number.isSafeInteger(maxRuleId) ||
		maxRuleId < 1 ||
		capacity > maxRuleId
	) {
		throw new RangeError("Allocated rule IDs exceed the supported DNR ID range.");
	}

	const totalWeight = definitions.reduce((total, definition) => {
		if (
			!Number.isSafeInteger(definition.ruleWeight) ||
			definition.ruleWeight <= 0
		) {
			throw new RangeError(
				`Filter list '${definition.id}' must have a positive integer rule weight.`
			);
		}

		return total + definition.ruleWeight;
	}, 0);

	const shares = definitions.map((definition, index) => {
		const exactShare = (capacity * definition.ruleWeight) / totalWeight;
		const maxRules = Math.floor(exactShare);

		return {
			definition,
			index,
			maxRules,
			remainder: exactShare - maxRules
		};
	});

	let unassigned = capacity -
		shares.reduce((total, share) => total + share.maxRules, 0);
	const remainderOrder = [...shares].sort(
		(first, second) =>
			second.remainder - first.remainder || first.index - second.index
	);

	for (const share of remainderOrder) {
		if (unassigned === 0) {
			break;
		}

		shares[share.index]!.maxRules += 1;
		unassigned -= 1;
	}

	let nextRuleId = 1;
	return shares.map(({ definition, maxRules }) => {
		const allocation = {
			id: definition.id,
			firstRuleId: nextRuleId,
			maxRules
		};

		nextRuleId += maxRules;
		return allocation;
	});
}
