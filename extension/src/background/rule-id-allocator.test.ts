import { describe, expect, it } from "vitest";

import { FILTER_LISTS } from "./filter-lists.js";
import { allocateFilterListRuleRanges } from "./rule-id-allocator.js";

describe("allocateFilterListRuleRanges", () => {
	it("preserves the existing 3500/1500 Firefox allocation", () => {
		expect(allocateFilterListRuleRanges(FILTER_LISTS, 5_000)).toEqual([
			{ id: "easylist", firstRuleId: 1, maxRules: 3_500 },
			{ id: "easyprivacy", firstRuleId: 3_501, maxRules: 1_500 }
		]);
	});

	it("scales the same weights across the 30000-rule Chrome capacity", () => {
		expect(allocateFilterListRuleRanges(FILTER_LISTS, 30_000)).toEqual([
			{ id: "easylist", firstRuleId: 1, maxRules: 21_000 },
			{ id: "easyprivacy", firstRuleId: 21_001, maxRules: 9_000 }
		]);
	});

	it("distributes remainder deterministically without gaps or overlaps", () => {
		const allocations = allocateFilterListRuleRanges(FILTER_LISTS, 37);

		expect(allocations).toEqual([
			{ id: "easylist", firstRuleId: 1, maxRules: 26 },
			{ id: "easyprivacy", firstRuleId: 27, maxRules: 11 }
		]);
		expect(allocations.reduce((total, item) => total + item.maxRules, 0)).toBe(
			37
		);
	});

	it("supports zero capacity without allocating invalid IDs", () => {
		expect(allocateFilterListRuleRanges(FILTER_LISTS, 0)).toEqual([
			{ id: "easylist", firstRuleId: 1, maxRules: 0 },
			{ id: "easyprivacy", firstRuleId: 1, maxRules: 0 }
		]);
	});

	it("rejects invalid capacity and list weights", () => {
		expect(() => allocateFilterListRuleRanges(FILTER_LISTS, -1)).toThrow(
			"non-negative safe integer"
		);
		expect(() =>
			allocateFilterListRuleRanges(FILTER_LISTS, 5_000, 4_999)
		).toThrow("supported DNR ID range");
		expect(() =>
			allocateFilterListRuleRanges(
				[{ ...FILTER_LISTS[0]!, ruleWeight: 0 }],
				5
			)
		).toThrow("positive integer rule weight");
	});
});
