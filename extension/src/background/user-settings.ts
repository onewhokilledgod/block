export const USER_SETTINGS_RECORD_ID = "current" as const;
export const USER_SETTINGS_SCHEMA_VERSION = 1;

export type UserThemePreference = "system" | "light" | "dark";

export interface UserSettings {
	networkFilteringEnabled: boolean;
	cosmeticFilteringEnabled: boolean;
	automaticFilterListUpdatesEnabled: boolean;
	filterListUpdateIntervalMinutes: number;
	theme: UserThemePreference;
}

export type UserSettingsPatch = Partial<UserSettings>;

export interface StoredUserSettingsRecord {
	id: typeof USER_SETTINGS_RECORD_ID;
	schemaVersion: typeof USER_SETTINGS_SCHEMA_VERSION;
	settings: UserSettings;
	updatedAt: number;
}

export const DEFAULT_USER_SETTINGS: Readonly<UserSettings> = Object.freeze({
	networkFilteringEnabled: true,
	cosmeticFilteringEnabled: true,
	automaticFilterListUpdatesEnabled: true,
	filterListUpdateIntervalMinutes: 1_440,
	theme: "system"
});

const MIN_UPDATE_INTERVAL_MINUTES = 30;
const MAX_UPDATE_INTERVAL_MINUTES = 10_080;

const SETTING_KEYS = new Set([
	"networkFilteringEnabled",
	"cosmeticFilteringEnabled",
	"automaticFilterListUpdatesEnabled",
	"filterListUpdateIntervalMinutes",
	"theme"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidUpdateInterval(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_UPDATE_INTERVAL_MINUTES &&
		value <= MAX_UPDATE_INTERVAL_MINUTES
	);
}

/**
 * Produces a complete, safe settings object from potentially stale persisted data.
 * Unknown or invalid values fall back individually to the current defaults.
 */
export function normalizeUserSettings(value: unknown): UserSettings {
	const source = isRecord(value) ? value : {};

	return {
		networkFilteringEnabled:
			typeof source.networkFilteringEnabled === "boolean"
				? source.networkFilteringEnabled
				: DEFAULT_USER_SETTINGS.networkFilteringEnabled,
		cosmeticFilteringEnabled:
			typeof source.cosmeticFilteringEnabled === "boolean"
				? source.cosmeticFilteringEnabled
				: DEFAULT_USER_SETTINGS.cosmeticFilteringEnabled,
		automaticFilterListUpdatesEnabled:
			typeof source.automaticFilterListUpdatesEnabled === "boolean"
				? source.automaticFilterListUpdatesEnabled
				: DEFAULT_USER_SETTINGS.automaticFilterListUpdatesEnabled,
		filterListUpdateIntervalMinutes: isValidUpdateInterval(source.filterListUpdateIntervalMinutes)
			? source.filterListUpdateIntervalMinutes
			: DEFAULT_USER_SETTINGS.filterListUpdateIntervalMinutes,
		theme:
			source.theme === "system" ||
			source.theme === "light" ||
			source.theme === "dark"
				? source.theme
				: DEFAULT_USER_SETTINGS.theme
	};
}

/**
 * Validates a partial update instead of silently accepting invalid UI or
 * runtime-message input. Unspecified settings retain their current values.
 */
export function mergeUserSettings(
	current: UserSettings,
	patch: UserSettingsPatch
): UserSettings {
	if (!isRecord(patch)) {
		throw new TypeError("Settings update must be an object.");
	}

	for (const [key, value] of Object.entries(patch)) {
		if (!SETTING_KEYS.has(key)) {
			throw new TypeError(`Unknown user setting: ${key}.`);
		}

		switch (key) {
			case "networkFilteringEnabled":
			case "cosmeticFilteringEnabled":
			case "automaticFilterListUpdatesEnabled":
				if (typeof value !== "boolean") {
					throw new TypeError(`User setting '${key}' must be a boolean.`);
				}
				break;
			case "filterListUpdateIntervalMinutes":
				if (!isValidUpdateInterval(value)) {
					throw new RangeError(
						`Update interval must be an integer between ${MIN_UPDATE_INTERVAL_MINUTES} and ${MAX_UPDATE_INTERVAL_MINUTES} minutes.`
					);
				}
				break;
			case "theme":
				if (value !== "system" && value !== "light" && value !== "dark") {
					throw new TypeError(
						"Theme must be 'system', 'light', or 'dark'."
					);
				}
				break;
		}
	}

	return normalizeUserSettings({ ...current, ...patch });
}

/** Creates the versioned record written to IndexedDB. */
export function createStoredUserSettingsRecord(
	settings: UserSettings,
	updatedAt = Date.now()
): StoredUserSettingsRecord {
	if (!Number.isFinite(updatedAt) || updatedAt < 0) {
		throw new RangeError("Settings updatedAt must be a non-negative timestamp.");
	}

	return {
		id: USER_SETTINGS_RECORD_ID,
		schemaVersion: USER_SETTINGS_SCHEMA_VERSION,
		settings: { ...settings },
		updatedAt
	};
}

/**
 * Reads versioned settings records. Version 0 stored settings directly on the
 * record; version 1 stores them under `settings`. Future versions are rejected
 * so an older extension cannot overwrite data written by a newer release.
 */
export function decodeStoredUserSettingsRecord(value: unknown): {
	settings: UserSettings;
	needsRewrite: boolean;
} {
	if (value === undefined || value === null) {
		return { settings: { ...DEFAULT_USER_SETTINGS }, needsRewrite: true };
	}

	if (!isRecord(value)) {
		return { settings: { ...DEFAULT_USER_SETTINGS }, needsRewrite: true };
	}

	const schemaVersion = value.schemaVersion ?? 0;
	if (
		typeof schemaVersion !== "number" ||
		!Number.isSafeInteger(schemaVersion) ||
		schemaVersion < 0
	) {
		throw new Error("Stored user settings have an invalid schema version.");
	}

	if (schemaVersion > USER_SETTINGS_SCHEMA_VERSION) {
		throw new Error(
			"Stored user settings were created by a newer version of Block. " +
				"They were left unchanged."
		);
	}

	const source =
		schemaVersion === 0 && value.settings === undefined
			? value
			: value.settings;
	const settings = normalizeUserSettings(source);
	const sourceSettings = isRecord(source) ? source : {};
	const settingKeys = Object.keys(DEFAULT_USER_SETTINGS) as Array<keyof UserSettings>;
	const hasCurrentFields = settingKeys.every(
		key => sourceSettings[key] === settings[key]
	);
	const hasOnlyCurrentFields = Object.keys(sourceSettings).every(key =>
		SETTING_KEYS.has(key)
	);

	return {
		settings,
		needsRewrite:
			schemaVersion !== USER_SETTINGS_SCHEMA_VERSION ||
			!hasCurrentFields ||
			!hasOnlyCurrentFields ||
			!(typeof value.updatedAt === "number" && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0)
	};
}
