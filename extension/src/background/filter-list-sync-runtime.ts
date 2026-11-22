import { FILTER_LIST_REFRESH_INTERVAL_MS } from "./filter-lists.js";

import {
	getBrowserLifecycleApi,
	type BrowserLifecycleApi
} from "./browser-lifecycle-api.js";

import type { FilterListSyncResult } from "./filter-list-sync-manager.js";

export const FILTER_LIST_SYNC_ALARM_NAME = "block-filter-list-refresh";

export const FILTER_LIST_SYNC_PERIOD_MINUTES =
	FILTER_LIST_REFRESH_INTERVAL_MS / 60_000;

type SyncAction = () => Promise<FilterListSyncResult>;

export interface SyncRuntimeLogger {
	info(message: string, details?: unknown): void;
	error(message: string, error: unknown): void;
}

const defaultLogger: SyncRuntimeLogger = {
	info: (message, details) => {
		console.info(message, details);
	},
	error: (message, error) => {
		console.error(message, error);
	}
};

export class FilterListSyncRuntime {
	private listenersRegistered = false;

	private syncPromise?: Promise<FilterListSyncResult>;

	constructor(
		private readonly syncAction: SyncAction,
		private readonly api: BrowserLifecycleApi = getBrowserLifecycleApi(),
		private readonly logger: SyncRuntimeLogger = defaultLogger
	) {}

	/**
	 * Must be called synchronously during background startup.
	 *
	 * Calling it multiple times on the same instance is safe.
	 */
	registerListeners(): void {
		if (this.listenersRegistered) {
			return;
		}

		this.listenersRegistered = true;

		this.api.alarms.onAlarm.addListener(alarm => {
			if (alarm.name !== FILTER_LIST_SYNC_ALARM_NAME) {
				return;
			}

			this.triggerSync("scheduled alarm");
		});

		this.api.runtime.onInstalled.addListener(() => {
			this.triggerSync("extension installed or updated");
		});

		this.api.runtime.onStartup.addListener(() => {
			this.triggerSync("browser startup");
		});
	}

	/**
	 * Recreates an absent or incorrectly configured alarm.
	 */
	async ensureAlarm(): Promise<void> {
		const existing = await this.api.alarms.get(FILTER_LIST_SYNC_ALARM_NAME);

		if (existing?.periodInMinutes === FILTER_LIST_SYNC_PERIOD_MINUTES) {
			return;
		}

		await this.api.alarms.create(FILTER_LIST_SYNC_ALARM_NAME, {
			periodInMinutes: FILTER_LIST_SYNC_PERIOD_MINUTES
		});

		this.logger.info(
			`[Block] Filter list refresh alarm configured: ` +
				`${FILTER_LIST_SYNC_PERIOD_MINUTES} minutes.`
		);
	}

	/**
	 * Concurrent requests share one synchronization operation.
	 */
	runSync(reason: string): Promise<FilterListSyncResult> {
		if (this.syncPromise) {
			return this.syncPromise;
		}

		const operation = (async () => {
			await this.ensureAlarm();

			this.logger.info(
				`[Block] Starting filter list synchronization: ${reason}.`
			);

			const result = await this.syncAction();

			this.logger.info(
				"[Block] Filter list synchronization completed.",
				result
			);

			return result;
		})();

		this.syncPromise = operation;

		void operation.then(
			() => {
				if (this.syncPromise === operation) {
					this.syncPromise = undefined;
				}
			},
			() => {
				if (this.syncPromise === operation) {
					this.syncPromise = undefined;
				}
			}
		);

		return operation;
	}

	private triggerSync(reason: string): void {
		void this.runSync(reason).catch((error: unknown) => {
			this.logger.error(
				`[Block] Filter list synchronization failed: ${reason}.`,
				error
			);
		});
	}
}
