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
	getDynamicRules(): Promise<ExistingDynamicRule[]>;

	updateDynamicRules(options: DynamicRulesUpdate): Promise<void>;

	isRegexSupported?(options: RegexOptions): Promise<RegexSupportResult>;
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
