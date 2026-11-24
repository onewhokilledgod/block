import { initializeFilterEngine } from "../shared/filter-engine.js";
import type { FilterEngine } from "../shared/filter-engine.js";
import {
	getBrowserRuntimeApi,
	type BrowserMessageSender
} from "../shared/browser-content-api.js";
import { REFRESH_FILTER_LISTS_MESSAGE } from "../shared/options-messages.js";

import { DnrRulesManager } from "./rules-manager.js";
import { FilterEngineManager } from "./engine-manager.js";

import { FilterListStorage } from "./filter-list-storage.js";
import { FilterListManager } from "./filter-list-manager.js";
import { FilterListSyncManager } from "./filter-list-sync-manager.js";

import { FilterListSyncRuntime } from "./filter-list-sync-runtime.js";
import { CosmeticContentRuntime } from "./cosmetic-content-runtime.js";

interface BackgroundServices {
	storage: FilterListStorage;
	filterEngine: FilterEngine;
	engineManager: FilterEngineManager;
	syncManager: FilterListSyncManager;
}

const storage = new FilterListStorage();

let servicesPromise: Promise<BackgroundServices> | undefined;

/**
 * Creates the background services only once per worker lifetime.
 *
 * A failed initialization can be retried later.
 */
function getBackgroundServices(): Promise<BackgroundServices> {
	if (servicesPromise) {
		return servicesPromise;
	}

	const creation = (async (): Promise<BackgroundServices> => {
		const engine = await initializeFilterEngine();

		const rulesManager = new DnrRulesManager();

		const engineManager = new FilterEngineManager(engine, rulesManager);

		const downloader = new FilterListManager(storage);

		const syncManager = new FilterListSyncManager(
			downloader,
			storage,
			engineManager
		);

		return {
			storage,
			filterEngine: engine,
			engineManager,
			syncManager
		};
	})();

	servicesPromise = creation;

	void creation.catch(() => {
		if (servicesPromise === creation) {
			servicesPromise = undefined;
		}
	});

	return creation;
}

const syncRuntime = new FilterListSyncRuntime(async options => {
	const services = await getBackgroundServices();

	return services.syncManager.sync(options);
});

// IMPORTANT:
// Register listeners before any asynchronous initialization.
syncRuntime.registerListeners();

function isExtensionPageSender(sender: BrowserMessageSender): boolean {
	if (!sender.url) {
		return false;
	}

	try {
		const protocol = new URL(sender.url).protocol;
		return protocol === "chrome-extension:" || protocol === "moz-extension:";
	} catch {
		return false;
	}
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Manual refresh requests are accepted only from extension pages, not from
// content scripts running on arbitrary websites.
getBrowserRuntimeApi().onMessage.addListener((message, sender, sendResponse) => {
	if (
		!message ||
		typeof message !== "object" ||
		(message as Record<string, unknown>).type !== REFRESH_FILTER_LISTS_MESSAGE
	) {
		return false;
	}

	if (!isExtensionPageSender(sender)) {
		sendResponse({ ok: false, error: "This action is only available to extension pages." });
		return false;
	}

	void syncRuntime.runSync("options page manual refresh", { forceApply: true }).then(
		result => sendResponse({ ok: true, result }),
		error => sendResponse({ ok: false, error: getErrorMessage(error) })
	);

	return true;
});

const cosmeticRuntime = new CosmeticContentRuntime(getBackgroundServices);
cosmeticRuntime.registerListeners();

async function initializeBackground(): Promise<void> {
	const services = await getBackgroundServices();

	// Create the versioned defaults on a fresh install and load saved preferences.
	await services.storage.getUserSettings();

	console.info("[Block] WASM filter engine initialized successfully.");

	const managedRuleIds = await services.engineManager.getManagedRuleIds();

	console.info(
		`[Block] DNR manager initialized. ` +
			`${managedRuleIds.length} managed dynamic rules installed.`
	);

	console.info("[Block] Filter engine manager initialized successfully.");

	// Recreate the alarm if it disappeared during a browser restart
	// or extension update.
	await syncRuntime.ensureAlarm();

	const [activeRecords, pendingSnapshot] = await Promise.all([
		services.storage.getAllActive(),
		services.storage.getPendingActiveSnapshot()
	]);

	// A fresh installation has no active lists.
	// An interrupted installation has a pending snapshot.
	if (activeRecords.length === 0 || pendingSnapshot !== null) {
		try {
			await syncRuntime.runSync(
				pendingSnapshot ? "pending snapshot recovery" : "initial installation"
			);
		} catch (error: unknown) {
			console.error(
				"[Block] Initial filter synchronization failed. " +
					"Existing browser rules were not intentionally cleared.",
				error
			);
		}
	}
}

void initializeBackground().catch((error: unknown) => {
	console.error("[Block] Background initialization failed.", error);
});
