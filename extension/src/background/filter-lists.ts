export type FilterListId = string;

export interface FilterListDefinition {
	id: FilterListId;
	name: string;
	url: string;
	expectedTitle: string;
	ruleWeight: number;
	maxBytes: number;
	enabledByDefault: boolean;
}

const MAX_LIST_BYTES = 8 * 1024 * 1024;

export const FILTER_LISTS: readonly FilterListDefinition[] = [
	{
		id: "easylist",
		name: "EasyList",
		url: "https://easylist.to/easylist/easylist.txt",
		expectedTitle: "EasyList",
		ruleWeight: 7,
		maxBytes: MAX_LIST_BYTES,
		enabledByDefault: true
	},
	{
		id: "easyprivacy",
		name: "EasyPrivacy",
		url: "https://easylist.to/easylist/easyprivacy.txt",
		expectedTitle: "EasyPrivacy",
		ruleWeight: 3,
		maxBytes: MAX_LIST_BYTES,
		enabledByDefault: true
	}
];

export const FILTER_LIST_FETCH_TIMEOUT_MS = 30_000;

export const FILTER_LIST_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const MIN_FILTER_LINES = 100;

export function getFilterListDefinition(
	id: FilterListId
): FilterListDefinition {
	const definition = FILTER_LISTS.find(list => list.id === id);

	if (!definition) {
		throw new Error(`Unknown filter list: ${id}`);
	}

	return definition;
}
