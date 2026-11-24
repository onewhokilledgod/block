import {
	FILTER_LISTS,
	type FilterListDefinition,
	type FilterListId
} from "./filter-lists.js";

export const DEFAULT_CUSTOM_LIST_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_FILTER_LIST_NAME_LENGTH = 80;
export const MAX_FILTER_LIST_URL_LENGTH = 2_048;

export interface StoredFilterListSubscription {
	id: FilterListId;
	name: string;
	url: string;
	enabled: boolean;
	builtIn: boolean;
	expectedTitle?: string;
	ruleWeight: number;
	maxBytes: number;
	addedAt: number;
}

export interface AddCustomFilterListInput {
	name?: string;
	url: string;
}

/**
 * Custom subscriptions are deliberately restricted to HTTPS URLs. Embedded
 * credentials and fragments are rejected so secrets are not persisted as part
 * of a subscription URL and fragments cannot create duplicate identities.
 */
export function normalizeCustomFilterListUrl(value: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("Filter list URL is required.");
	}

	if (value.length > MAX_FILTER_LIST_URL_LENGTH) {
		throw new RangeError("Filter list URL is too long.");
	}

	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new TypeError("Filter list URL must be a valid absolute URL.");
	}

	if (url.protocol !== "https:") {
		throw new TypeError("Custom filter lists must use HTTPS.");
	}

	if (url.username || url.password) {
		throw new TypeError("Filter list URLs must not contain credentials.");
	}

	if (url.hash || value.trim().includes("#")) {
		throw new TypeError("Filter list URLs must not contain fragments.");
	}

	if (!url.hostname || url.origin === "null") {
		throw new TypeError("Filter list URL must include a valid host.");
	}

	return url.href;
}

export function normalizeCustomFilterListName(
	name: string | undefined,
	url: string
): string {
	const candidate = name?.trim() || new URL(url).hostname;

	if (candidate.length === 0 || candidate.length > MAX_FILTER_LIST_NAME_LENGTH) {
		throw new RangeError(
			`Filter list name must contain between 1 and ${MAX_FILTER_LIST_NAME_LENGTH} characters.`
		);
	}

	return candidate;
}

export function createBuiltInFilterListSubscriptions(
	addedAt = 0
): StoredFilterListSubscription[] {
	return FILTER_LISTS.map((definition: FilterListDefinition) => ({
		id: definition.id,
		name: definition.name,
		url: definition.url,
		enabled: definition.enabledByDefault,
		builtIn: true,
		expectedTitle: definition.expectedTitle,
		ruleWeight: definition.ruleWeight,
		maxBytes: definition.maxBytes,
		addedAt
	}));
}
