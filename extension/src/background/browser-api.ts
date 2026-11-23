import type { DnrRule } from "../shared/filter-engine.js";

export interface RegexOptions {
	regex: string;
	isCaseSensitive?: boolean;
	requireCapturing?: boolean;
}

export interface RegexSupportResult {
	isSupported: boolean;
	reason?: string;
}

export interface ExistingDynamicRule {
	id: number;
}

export interface DynamicRulesUpdate {
	removeRuleIds: number[];
	addRules: DnrRule[];
}

export interface DeclarativeNetRequestApi {
	readonly MAX_NUMBER_OF_DYNAMIC_RULES?: number;
	readonly MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES?: number;
	readonly MAX_NUMBER_OF_REGEX_RULES?: number;
	readonly MAX_NUMBER_OF_SESSION_RULES?: number;

	getDynamicRules(): Promise<ExistingDynamicRule[]>;

	updateDynamicRules(options: DynamicRulesUpdate): Promise<void>;

	isRegexSupported?(options: RegexOptions): Promise<RegexSupportResult>;

	getSessionRules?(): Promise<unknown[]>;
	updateSessionRules?(options: unknown): Promise<void>;

	getEnabledRulesets?(): Promise<string[]>;
	updateEnabledRulesets?(options: unknown): Promise<void>;
	updateStaticRules?(options: unknown): Promise<void>;
	getAvailableStaticRuleCount?(): Promise<number>;
	getMatchedRules?(filter?: unknown): Promise<unknown[]>;
}

interface ExtensionApiNamespace {
	declarativeNetRequest?: DeclarativeNetRequestApi;
}

interface ExtensionGlobals {
	browser?: ExtensionApiNamespace;
	chrome?: ExtensionApiNamespace;
}

/**
 * Returns the browser's DNR API.
 *
 * Firefox exposes the Promise-based `browser` namespace.
 * Chromium exposes the Promise-based `chrome` namespace.
 */
export function getDnrApi(): DeclarativeNetRequestApi {
	const globals = globalThis as typeof globalThis & ExtensionGlobals;

	const api =
		globals.browser?.declarativeNetRequest ??
		globals.chrome?.declarativeNetRequest;

	if (!api) {
		throw new Error(
			"declarativeNetRequest API is unavailable. " +
				"Check the extension manifest and permissions."
		);
	}

	return api;
}
