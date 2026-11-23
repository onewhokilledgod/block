import type { DeclarativeNetRequestApi } from "./browser-api.js";

// Keep allocated IDs within the signed 32-bit range used by the Rust/WASM model.
export const MAX_DNR_RULE_ID = 2_147_483_647;

export const FALLBACK_DNR_LIMITS = Object.freeze({
	dynamicRules: 5_000,
	unsafeDynamicRules: 5_000,
	regexRules: 1_000,
	sessionRules: 5_000
});

export interface BrowserDnrFeatures {
	dynamicRules: true;
	regexValidation: boolean;
	unsafeDynamicRuleQuota: boolean;
	sessionRules: boolean;
	enabledRulesetQueries: boolean;
	staticRulesetUpdates: boolean;
	staticRuleUpdates: boolean;
	staticRuleAvailability: boolean;
	matchedRuleQueries: boolean;
}

export interface BrowserCapabilities {
	maxDynamicRules: number;
	maxUnsafeDynamicRules: number;
	maxRegexRules: number;
	maxSessionRules: number;
	maxRuleId: number;
	features: BrowserDnrFeatures;
}

function readLimit(
	value: number | undefined,
	fallback: number,
	allowZero = false
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < (allowZero ? 0 : 1)
	) {
		return fallback;
	}

	return value;
}

/**
 * Resolves DNR capabilities from the API exposed by the running browser.
 * No user-agent parsing is used: Chromium and Firefox publish their own
 * quota constants on the declarativeNetRequest namespace.
 */
export function detectBrowserCapabilities(
	api: DeclarativeNetRequestApi
): BrowserCapabilities {
	if (
		typeof api.getDynamicRules !== "function" ||
		typeof api.updateDynamicRules !== "function"
	) {
		throw new Error(
			"The browser does not expose the required dynamic DNR rules API."
		);
	}

	const features: BrowserDnrFeatures = {
		dynamicRules: true,
		regexValidation: typeof api.isRegexSupported === "function",
		unsafeDynamicRuleQuota:
			typeof api.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES === "number",
		sessionRules:
			typeof api.getSessionRules === "function" &&
			typeof api.updateSessionRules === "function",
		enabledRulesetQueries: typeof api.getEnabledRulesets === "function",
		staticRulesetUpdates: typeof api.updateEnabledRulesets === "function",
		staticRuleUpdates: typeof api.updateStaticRules === "function",
		staticRuleAvailability:
			typeof api.getAvailableStaticRuleCount === "function",
		matchedRuleQueries: typeof api.getMatchedRules === "function"
	};

	const maxDynamicRules = readLimit(
		api.MAX_NUMBER_OF_DYNAMIC_RULES,
		FALLBACK_DNR_LIMITS.dynamicRules
	);
	const maxUnsafeDynamicRules = Math.min(
		maxDynamicRules,
		readLimit(
			api.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
			Math.min(maxDynamicRules, FALLBACK_DNR_LIMITS.unsafeDynamicRules)
		)
	);

	return {
		maxDynamicRules,
		maxUnsafeDynamicRules,
		maxRegexRules: readLimit(
			api.MAX_NUMBER_OF_REGEX_RULES,
			FALLBACK_DNR_LIMITS.regexRules,
			true
		),
		maxSessionRules: features.sessionRules
			? readLimit(
					api.MAX_NUMBER_OF_SESSION_RULES,
					FALLBACK_DNR_LIMITS.sessionRules,
					true
			  )
			: 0,
		maxRuleId: MAX_DNR_RULE_ID,
		features
	};
}
