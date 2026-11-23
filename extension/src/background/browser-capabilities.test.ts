import { describe, expect, it } from "vitest";

import type { DeclarativeNetRequestApi } from "./browser-api.js";
import {
	FALLBACK_DNR_LIMITS,
	MAX_DNR_RULE_ID,
	detectBrowserCapabilities
} from "./browser-capabilities.js";

function createApi(): DeclarativeNetRequestApi {
	return {
		getDynamicRules: async () => [],
		updateDynamicRules: async () => undefined
	};
}

describe("detectBrowserCapabilities", () => {
	it("detects Chrome dynamic, unsafe, regex, session and optional API limits", () => {
		const api = Object.assign(createApi(), {
			MAX_NUMBER_OF_DYNAMIC_RULES: 30_000,
			MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5_000,
			MAX_NUMBER_OF_REGEX_RULES: 1_000,
			MAX_NUMBER_OF_SESSION_RULES: 5_000,
			isRegexSupported: async () => ({ isSupported: true }),
			getSessionRules: async () => [],
			updateSessionRules: async () => undefined,
			getEnabledRulesets: async () => [],
			updateEnabledRulesets: async () => undefined,
			getAvailableStaticRuleCount: async () => 30_000,
			getMatchedRules: async () => []
		});

		expect(detectBrowserCapabilities(api)).toEqual({
			maxDynamicRules: 30_000,
			maxUnsafeDynamicRules: 5_000,
			maxRegexRules: 1_000,
			maxSessionRules: 5_000,
			maxRuleId: MAX_DNR_RULE_ID,
			features: {
				dynamicRules: true,
				regexValidation: true,
				unsafeDynamicRuleQuota: true,
				sessionRules: true,
				enabledRulesetQueries: true,
				staticRulesetUpdates: true,
				staticRuleUpdates: false,
				staticRuleAvailability: true,
				matchedRuleQueries: true
			}
		});
	});

	it("uses Firefox limits with the conservative unsafe-rule fallback", () => {
		const api = Object.assign(createApi(), {
			MAX_NUMBER_OF_DYNAMIC_RULES: 5_000,
			MAX_NUMBER_OF_REGEX_RULES: 1_000,
			MAX_NUMBER_OF_SESSION_RULES: 5_000,
			isRegexSupported: async () => ({ isSupported: true }),
			getSessionRules: async () => [],
			updateSessionRules: async () => undefined,
			updateStaticRules: async () => undefined
		});

		const capabilities = detectBrowserCapabilities(api);
		expect(capabilities.maxDynamicRules).toBe(5_000);
		expect(capabilities.maxUnsafeDynamicRules).toBe(5_000);
		expect(capabilities.maxRegexRules).toBe(1_000);
		expect(capabilities.features.staticRulesetUpdates).toBe(false);
		expect(capabilities.features.staticRuleUpdates).toBe(true);
		expect(capabilities.features.enabledRulesetQueries).toBe(false);
	});

	it("falls back conservatively when quota constants and optional APIs are absent", () => {
		const capabilities = detectBrowserCapabilities(createApi());

		expect(capabilities.maxDynamicRules).toBe(
			FALLBACK_DNR_LIMITS.dynamicRules
		);
		expect(capabilities.maxUnsafeDynamicRules).toBe(
			FALLBACK_DNR_LIMITS.unsafeDynamicRules
		);
		expect(capabilities.maxRegexRules).toBe(FALLBACK_DNR_LIMITS.regexRules);
		expect(capabilities.maxSessionRules).toBe(0);
		expect(capabilities.features).toEqual({
			dynamicRules: true,
			regexValidation: false,
			unsafeDynamicRuleQuota: false,
			sessionRules: false,
			enabledRulesetQueries: false,
			staticRulesetUpdates: false,
			staticRuleUpdates: false,
			staticRuleAvailability: false,
			matchedRuleQueries: false
		});
	});

	it("does not trust invalid quota values", () => {
		const api = Object.assign(createApi(), {
			MAX_NUMBER_OF_DYNAMIC_RULES: Number.POSITIVE_INFINITY,
			MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: -1,
			MAX_NUMBER_OF_REGEX_RULES: -1
		});

		const capabilities = detectBrowserCapabilities(api);
		expect(capabilities.maxDynamicRules).toBe(5_000);
		expect(capabilities.maxUnsafeDynamicRules).toBe(5_000);
		expect(capabilities.maxRegexRules).toBe(1_000);
	});

	it("fails early when required dynamic DNR methods are unavailable", () => {
		const api = {
			getDynamicRules: async () => []
		} as unknown as DeclarativeNetRequestApi;

		expect(() => detectBrowserCapabilities(api)).toThrow(
			"required dynamic DNR rules API"
		);
	});
});
