import { describe, expect, it } from "vitest";

import type { CosmeticFilter, DomainRestriction } from "../shared/filter-engine.js";

import { CosmeticRuleEngine } from "./cosmetic-rule-engine.js";

function domain(domain: string, include = true): DomainRestriction {
	return { domain, include };
}

function cosmeticFilter(
	selector: string,
	domains: DomainRestriction[] = [],
	exception = false
): CosmeticFilter {
	return {
		kind: "cosmetic",
		domains,
		selector,
		exception,
		sourceLine: 1
	};
}

describe("CosmeticRuleEngine", () => {
	it("applies generic rules to every valid hostname", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".generic-ad")
		]);

		expect(engine.getSelectorsForHostname("example.com")).toEqual([
			".generic-ad"
		]);
		expect(engine.getSelectorsForHostname("news.example.org")).toEqual([
			".generic-ad"
		]);
	});

	it("matches a domain and its subdomains without matching suffix lookalikes", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".ad", [domain("example.com")])
		]);

		expect(engine.getSelectorsForHostname("example.com")).toEqual([".ad"]);
		expect(engine.getSelectorsForHostname("shop.example.com")).toEqual([
			".ad"
		]);
		expect(engine.getSelectorsForHostname("notexample.com")).toEqual([]);
		expect(engine.getSelectorsForHostname("example.org")).toEqual([]);
	});

	it("applies exclusions to a domain and all of its subdomains", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".ad", [
				domain("example.com"),
				domain("news.example.com", false)
			])
		]);

		expect(engine.getSelectorsForHostname("shop.example.com")).toEqual([
			".ad"
		]);
		expect(engine.getSelectorsForHostname("news.example.com")).toEqual([]);
		expect(engine.getSelectorsForHostname("sub.news.example.com")).toEqual(
			[]
		);
	});

	it("treats exclusion-only domain lists as global rules with exceptions", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".ad", [domain("trusted.example", false)])
		]);

		expect(engine.getSelectorsForHostname("ordinary.example")).toEqual([
			".ad"
		]);
		expect(engine.getSelectorsForHostname("trusted.example")).toEqual([]);
		expect(engine.getSelectorsForHostname("shop.trusted.example")).toEqual(
			[]
		);
	});

	it("supports a wildcard top-level domain and its subdomains", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".ad", [domain("example.*")])
		]);

		expect(engine.getSelectorsForHostname("example.com")).toEqual([".ad"]);
		expect(engine.getSelectorsForHostname("example.co.uk")).toEqual([
			".ad"
		]);
		expect(engine.getSelectorsForHostname("shop.example.de")).toEqual([
			".ad"
		]);
		expect(engine.getSelectorsForHostname("notexample.com")).toEqual([]);
	});

	it("normalizes hostname case, trailing dots and IDN domains", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".ad", [domain("EXAMPLE.COM")]),
			cosmeticFilter(".idn-ad", [domain("bücher.example")])
		]);

		expect(engine.getSelectorsForHostname("WWW.Example.Com.")).toEqual([
			".ad"
		]);
		expect(
			engine.getSelectorsForHostname("shop.xn--bcher-kva.example")
		).toEqual([".idn-ad"]);
	});

	it("applies cosmetic exceptions regardless of their position in the list", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".ad", [], true),
			cosmeticFilter(".ad")
		]);

		expect(engine.getSelectorsForHostname("example.com")).toEqual([]);
	});

	it("applies domain-specific exceptions only on their matching domain", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".ad"),
			cosmeticFilter(".ad", [domain("example.com")], true)
		]);

		expect(engine.getSelectorsForHostname("example.com")).toEqual([]);
		expect(engine.getSelectorsForHostname("shop.example.com")).toEqual([]);
		expect(engine.getSelectorsForHostname("other.example")).toEqual([
			".ad"
		]);
	});

	it("requires an exact selector match for an exception", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".ad"),
			cosmeticFilter(".ad-slot", [domain("example.com")], true)
		]);

		expect(engine.getSelectorsForHostname("example.com")).toEqual([
			".ad"
		]);
	});

	it("deduplicates active selectors while preserving their first-seen order", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".first"),
			cosmeticFilter(".second"),
			cosmeticFilter(".first")
		]);

		expect(engine.getSelectorsForHostname("example.com")).toEqual([
			".first",
			".second"
		]);
	});

	it("fails closed for invalid hostnames", () => {
		const engine = new CosmeticRuleEngine([cosmeticFilter(".ad")]);

		expect(engine.getSelectorsForHostname("")).toEqual([]);
		expect(engine.getSelectorsForHostname("example.com/path")).toEqual([]);
		expect(engine.getSelectorsForHostname("example.com:8080")).toEqual([]);
	});

	it("skips a rule completely when any domain restriction is invalid", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter(".ad", [
				domain("example.com"),
				domain("invalid domain", false)
			])
		]);

		expect(engine.getSelectorsForHostname("example.com")).toEqual([]);
	});

	it("ignores empty selectors", () => {
		const engine = new CosmeticRuleEngine([
			cosmeticFilter("   "),
			cosmeticFilter(".valid")
		]);

		expect(engine.getSelectorsForHostname("example.com")).toEqual([
			".valid"
		]);
	});
});
