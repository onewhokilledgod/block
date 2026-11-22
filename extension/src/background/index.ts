import { initializeFilterEngine } from "../shared/filter-engine.js";

import { DnrRulesManager } from "./rules-manager.js";
import { FilterEngineManager } from "./engine-manager.js";

import { FilterListStorage } from "./filter-list-storage.js";
import { FilterListManager } from "./filter-list-manager.js";
import { FilterListSyncManager } from "./filter-list-sync-manager.js";

import { FilterListSyncRuntime } from "./filter-list-sync-runtime.js";

interface BackgroundServices {
	storage: FilterListStorage;
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

const syncRuntime = new FilterListSyncRuntime(async () => {
	const services = await getBackgroundServices();

	return services.syncManager.sync();
});

// IMPORTANT:
// Register lifecycle listeners before any asynchronous initialization.
syncRuntime.registerListeners();

async function initializeBackground(): Promise<void> {
	const services = await getBackgroundServices();

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
