import { describe, expect, it, vi } from "vitest";

import { CosmeticSelectorProcessor } from "./cosmetic-selector-processor.js";

interface FakeCssRule {
	type: number;
	selectorText?: string;
}

class FakeCssStyleSheet {
	private readonly rules: FakeCssRule[] = [];

	get cssRules(): CSSRuleList {
		return this.rules as unknown as CSSRuleList;
	}

	insertRule(rule: string, index = this.rules.length): number {
		if (index < 0 || index > this.rules.length) {
			throw new RangeError("Invalid CSS rule index");
		}

		if (rule === ":root { --block-cosmetic-selector-probe: 0; }") {
			this.rules.splice(index, 0, { type: 1, selectorText: ":root" });
			return index;
		}

		const match = rule.match(
			/^([\s\S]+?)\s*\{\s*display:\s*none\s*!important;\s*\}$/i
		);

		if (!match) {
			throw new SyntaxError("Invalid test CSS rule");
		}

		const selector = match[1].trim();

		if (selector.startsWith("@import") && index > 0) {
			throw new Error("@import cannot follow a style rule");
		}

		if (!selector || /[{}]/.test(selector) || selector.includes("INVALID")) {
			throw new SyntaxError("Invalid test selector");
		}

		const ruleEntry: FakeCssRule = selector.startsWith("@")
			? { type: 4 }
			: { type: 1, selectorText: selector };

		this.rules.splice(index, 0, ruleEntry);
		return index;
	}

	deleteRule(index: number): void {
		if (index < 0 || index >= this.rules.length) {
			throw new RangeError("Invalid CSS rule index");
		}

		this.rules.splice(index, 1);
	}
}

function createProcessor(
	options: ConstructorParameters<typeof CosmeticSelectorProcessor>[0] = {}
): { processor: CosmeticSelectorProcessor; stylesheet: FakeCssStyleSheet } {
	const stylesheet = new FakeCssStyleSheet();
	const processor = new CosmeticSelectorProcessor({
		...options,
		createStyleSheet: () => stylesheet as unknown as CSSStyleSheet
	});

	return { processor, stylesheet };
}

describe("CosmeticSelectorProcessor", () => {
	it("generates CSS only for selectors accepted by the CSS parser", () => {
		const { processor } = createProcessor();

		const result = processor.process([".ad", "#sponsor", "INVALID("]);

		expect(result.selectors).toEqual([".ad", "#sponsor"]);
		expect(result.cssText).toBe(
			".ad { display: none !important; }\n#sponsor { display: none !important; }"
		);
		expect(result.diagnostics).toMatchObject([
			{ code: "invalidSelector", selector: "INVALID(" }
		]);
	});

	it("trims and deduplicates selectors", () => {
		const { processor } = createProcessor();

		const result = processor.process([" .ad ", ".ad", "#banner"]);

		expect(result.selectors).toEqual([".ad", "#banner"]);
		expect(result.cssText.match(/display: none !important/g)).toHaveLength(2);
	});

	it("preserves selector lists and nested commas as one CSS rule", () => {
		const { processor } = createProcessor();
		const selector = ".ad, :is(.sponsor, .promo)";

		const result = processor.process([selector]);

		expect(result.selectors).toEqual([selector]);
		expect(result.cssText).toBe(
			`${selector} { display: none !important; }`
		);
	});

	it("rejects empty and whitespace-only selectors", () => {
		const { processor } = createProcessor();

		const result = processor.process(["", "   ", ".valid"]);

		expect(result.selectors).toEqual([".valid"]);
		expect(result.diagnostics.filter(item => item.code === "emptySelector"))
			.toHaveLength(2);
	});

	it("rejects malformed selectors and CSS rule injection attempts", () => {
		const { processor } = createProcessor();

		const result = processor.process([
			".valid",
			".broken INVALID",
			".ad } body { color: red"
		]);

		expect(result.selectors).toEqual([".valid"]);
		expect(result.cssText).toBe(
			".valid { display: none !important; }"
		);
		expect(result.diagnostics.filter(item => item.code === "invalidSelector"))
			.toHaveLength(2);
	});

	it("rejects at-rules instead of treating them as selectors", () => {
		const { processor, stylesheet } = createProcessor();

		const result = processor.process([
			"@media all",
			'@import url("https://attacker.invalid/filters.css")'
		]);

		expect(result.selectors).toEqual([]);
		expect(result.cssText).toBe("");
		expect(result.diagnostics.filter(item => item.code === "invalidSelector"))
			.toHaveLength(2);
		// Only the permanent probe remains after a rejected at-rule.
		expect(stylesheet.cssRules).toHaveLength(1);
	});

	it("enforces the maximum selector length", () => {
		const { processor } = createProcessor({ maxSelectorLength: 8 });

		const result = processor.process([".short", ".selector-is-too-long"]);

		expect(result.selectors).toEqual([".short"]);
		expect(result.diagnostics[0]?.code).toBe("selectorTooLong");
	});

	it("stops after the configured number of distinct selectors", () => {
		const { processor } = createProcessor({ maxSelectors: 1 });

		const result = processor.process([".first", ".first", ".second", ".third"]);

		expect(result.selectors).toEqual([".first"]);
		expect(result.diagnostics).toMatchObject([
			{ code: "selectorLimitExceeded", selector: ".second" }
		]);
	});

	it("fails closed when a stylesheet cannot be created", () => {
		const processor = new CosmeticSelectorProcessor({
			createStyleSheet: () => {
				throw new Error("CSSStyleSheet is unavailable");
			}
		});

		const result = processor.process([".ad"]);

		expect(result.selectors).toEqual([]);
		expect(result.cssText).toBe("");
		expect(result.diagnostics[0]?.code).toBe("cssParserUnavailable");
	});

	it("does not require a stylesheet for an empty input", () => {
		const createStyleSheet = vi.fn(() => {
			throw new Error("should not be called");
		});
		const processor = new CosmeticSelectorProcessor({ createStyleSheet });

		expect(processor.process([])).toEqual({
			selectors: [],
			cssText: "",
			diagnostics: []
		});
		expect(createStyleSheet).not.toHaveBeenCalled();
	});

	it("rejects invalid processor limits", () => {
		expect(
			() => new CosmeticSelectorProcessor({ maxSelectors: -1 })
		).toThrow(RangeError);
		expect(
			() => new CosmeticSelectorProcessor({ maxSelectorLength: 0 })
		).toThrow(RangeError);
	});
});
