import { describe, expect, it, vi } from "vitest";

import type {
	BrowserAlarm,
	BrowserLifecycleApi
} from "./browser-lifecycle-api.js";

import type { FilterListSyncResult } from "./filter-list-sync-manager.js";

import {
	FILTER_LIST_SYNC_ALARM_NAME,
	FILTER_LIST_SYNC_PERIOD_MINUTES,
	FilterListSyncRuntime
} from "./filter-list-sync-runtime.js";

function createSyncResult(): FilterListSyncResult {
	return {
		download: {
			lists: [],
			updatedCount: 0,
			notModifiedCount: 0,
			cachedCount: 0
		},
		application: null,
		activeLists: [],
		skippedApplication: true,
		recoveredPendingSnapshot: false
	};
}

function createMockApi(initialAlarm?: BrowserAlarm) {
	let currentAlarm = initialAlarm;

	const alarmListeners: Array<(alarm: BrowserAlarm) => void> = [];

	const installedListeners: Array<() => void> = [];
	const startupListeners: Array<() => void> = [];

	const get = vi.fn(async (name: string) => {
		if (currentAlarm?.name !== name) {
			return undefined;
		}

		return { ...currentAlarm };
	});

	const create = vi.fn(
		async (name: string, info: { periodInMinutes: number }) => {
			currentAlarm = {
				name,
				periodInMinutes: info.periodInMinutes
			};
		}
	);

	const api: BrowserLifecycleApi = {
		alarms: {
			get,
			create,
			onAlarm: {
				addListener: vi.fn(listener => {
					alarmListeners.push(listener);
				})
			}
		},
		runtime: {
			onInstalled: {
				addListener: vi.fn(listener => {
					installedListeners.push(listener);
				})
			},
			onStartup: {
				addListener: vi.fn(listener => {
					startupListeners.push(listener);
				})
			}
		}
	};

	return {
		api,
		get,
		create,
		alarmListeners,
		installedListeners,
		startupListeners,
		getCurrentAlarm: () => currentAlarm
	};
}

describe("FilterListSyncRuntime", () => {
	it("registers lifecycle listeners only once", () => {
		const mock = createMockApi();

		const runtime = new FilterListSyncRuntime(
			vi.fn(async () => createSyncResult()),
			mock.api
		);

		runtime.registerListeners();
		runtime.registerListeners();

		expect(mock.alarmListeners).toHaveLength(1);
		expect(mock.installedListeners).toHaveLength(1);
		expect(mock.startupListeners).toHaveLength(1);
	});

	it("creates a daily alarm when none exists", async () => {
		const mock = createMockApi();

		const runtime = new FilterListSyncRuntime(
			vi.fn(async () => createSyncResult()),
			mock.api
		);

		await runtime.ensureAlarm();

		expect(mock.create).toHaveBeenCalledWith(FILTER_LIST_SYNC_ALARM_NAME, {
			periodInMinutes: FILTER_LIST_SYNC_PERIOD_MINUTES
		});

		expect(mock.getCurrentAlarm()?.periodInMinutes).toBe(1440);
	});

	it("does not replace an already configured alarm", async () => {
		const mock = createMockApi({
			name: FILTER_LIST_SYNC_ALARM_NAME,
			periodInMinutes: FILTER_LIST_SYNC_PERIOD_MINUTES
		});

		const runtime = new FilterListSyncRuntime(
			vi.fn(async () => createSyncResult()),
			mock.api
		);

		await runtime.ensureAlarm();

		expect(mock.create).not.toHaveBeenCalled();
	});

	it("recreates an incorrectly configured alarm", async () => {
		const mock = createMockApi({
			name: FILTER_LIST_SYNC_ALARM_NAME,
			periodInMinutes: 60
		});

		const runtime = new FilterListSyncRuntime(
			vi.fn(async () => createSyncResult()),
			mock.api
		);

		await runtime.ensureAlarm();

		expect(mock.create).toHaveBeenCalledWith(FILTER_LIST_SYNC_ALARM_NAME, {
			periodInMinutes: 1440
		});
	});

	it("ignores unrelated alarms", async () => {
		const mock = createMockApi();

		const syncAction = vi.fn(async () => createSyncResult());

		const runtime = new FilterListSyncRuntime(syncAction, mock.api);

		runtime.registerListeners();

		mock.alarmListeners[0]({
			name: "unrelated-alarm"
		});

		await new Promise(resolve => setTimeout(resolve, 0));

		expect(syncAction).not.toHaveBeenCalled();
	});

	it("runs synchronization for the configured alarm", async () => {
		const mock = createMockApi({
			name: FILTER_LIST_SYNC_ALARM_NAME,
			periodInMinutes: 1440
		});

		const syncAction = vi.fn(async () => createSyncResult());

		const runtime = new FilterListSyncRuntime(syncAction, mock.api);

		runtime.registerListeners();

		mock.alarmListeners[0]({
			name: FILTER_LIST_SYNC_ALARM_NAME
		});

		await vi.waitFor(() => {
			expect(syncAction).toHaveBeenCalledTimes(1);
		});
	});

	it("coalesces concurrent synchronization requests", async () => {
		const mock = createMockApi({
			name: FILTER_LIST_SYNC_ALARM_NAME,
			periodInMinutes: 1440
		});

		const syncAction = vi.fn(async () => createSyncResult());

		const runtime = new FilterListSyncRuntime(syncAction, mock.api);

		const first = runtime.runSync("first request");
		const second = runtime.runSync("second request");

		expect(first).toBe(second);

		await Promise.all([first, second]);

		expect(syncAction).toHaveBeenCalledTimes(1);
	});

	it("forces reapplication on extension install or update", async () => {
		const mock = createMockApi({
			name: FILTER_LIST_SYNC_ALARM_NAME,
			periodInMinutes: FILTER_LIST_SYNC_PERIOD_MINUTES
		});
		const syncAction = vi.fn(async (_options?: { forceApply?: boolean }) =>
			createSyncResult()
		);
		const runtime = new FilterListSyncRuntime(syncAction, mock.api);

		runtime.registerListeners();
		mock.installedListeners[0]?.();

		await vi.waitFor(() => {
			expect(syncAction).toHaveBeenCalledTimes(1);
		});
		expect(syncAction).toHaveBeenCalledWith({ forceApply: true });
	});

	it("forces reapplication on browser startup", async () => {
		const mock = createMockApi({
			name: FILTER_LIST_SYNC_ALARM_NAME,
			periodInMinutes: FILTER_LIST_SYNC_PERIOD_MINUTES
		});
		const syncAction = vi.fn(async (_options?: { forceApply?: boolean }) =>
			createSyncResult()
		);
		const runtime = new FilterListSyncRuntime(syncAction, mock.api);

		runtime.registerListeners();
		mock.startupListeners[0]?.();

		await vi.waitFor(() => {
			expect(syncAction).toHaveBeenCalledTimes(1);
		});
		expect(syncAction).toHaveBeenCalledWith({ forceApply: true });
	});

	it("queues a forced pass if an update arrives during synchronization", async () => {
		const mock = createMockApi({
			name: FILTER_LIST_SYNC_ALARM_NAME,
			periodInMinutes: FILTER_LIST_SYNC_PERIOD_MINUTES
		});
		let resolveFirst!: (result: FilterListSyncResult) => void;
		const firstResult = new Promise<FilterListSyncResult>(resolve => {
			resolveFirst = resolve;
		});
		const syncAction = vi.fn()
			.mockImplementationOnce(() => firstResult)
			.mockImplementation(async () => createSyncResult());
		const runtime = new FilterListSyncRuntime(syncAction, mock.api);

		const firstRun = runtime.runSync("browser startup");
		await vi.waitFor(() => {
			expect(syncAction).toHaveBeenCalledTimes(1);
		});

		const updateRun = runtime.runSync("extension updated", { forceApply: true });
		expect(updateRun).toBe(firstRun);

		resolveFirst(createSyncResult());
		await updateRun;

		expect(syncAction).toHaveBeenCalledTimes(2);
		expect(syncAction).toHaveBeenNthCalledWith(1, { forceApply: false });
		expect(syncAction).toHaveBeenNthCalledWith(2, { forceApply: true });
	});

	it("retains a forced request when synchronization fails", async () => {
		const mock = createMockApi({
			name: FILTER_LIST_SYNC_ALARM_NAME,
			periodInMinutes: FILTER_LIST_SYNC_PERIOD_MINUTES
		});
		const syncAction = vi.fn()
			.mockRejectedValueOnce(new Error("Network failure"))
			.mockResolvedValueOnce(createSyncResult());
		const runtime = new FilterListSyncRuntime(syncAction, mock.api);

		await expect(
			runtime.runSync("extension updated", { forceApply: true })
		).rejects.toThrow("Network failure");
		await expect(runtime.runSync("retry")).resolves.toEqual(createSyncResult());

		expect(syncAction).toHaveBeenCalledTimes(2);
		expect(syncAction).toHaveBeenNthCalledWith(1, { forceApply: true });
		expect(syncAction).toHaveBeenNthCalledWith(2, { forceApply: true });
	});

	it("allows retry after a failed synchronization", async () => {
		const mock = createMockApi({
			name: FILTER_LIST_SYNC_ALARM_NAME,
			periodInMinutes: 1440
		});

		const syncAction = vi
			.fn()
			.mockRejectedValueOnce(new Error("Network failure"))
			.mockResolvedValueOnce(createSyncResult());

		const runtime = new FilterListSyncRuntime(syncAction, mock.api);

		await expect(runtime.runSync("first")).rejects.toThrow("Network failure");

		await expect(runtime.runSync("retry")).resolves.toEqual(createSyncResult());

		expect(syncAction).toHaveBeenCalledTimes(2);
	});
});
