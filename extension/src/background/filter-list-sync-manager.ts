import { FILTER_LISTS, type FilterListId } from "./filter-lists.js";

import {
	FilterListStorage,
	type StoredFilterList
} from "./filter-list-storage.js";

import type {
	FilterListManager,
	FilterListRefreshReport
} from "./filter-list-manager.js";

import type {
	FilterEngineManager,
	FilterListInput,
	FilterListsApplyResult
} from "./engine-manager.js";

export interface FilterListSyncOptions {
	/**
	 * Recompile and replace DNR rules even when active list content is unchanged.
	 */
	forceApply?: boolean;
}

export interface ActiveListSummary {
	id: FilterListId;
	version: string;
	sha256: string;
}

export interface FilterListSyncResult {
	download: FilterListRefreshReport;
	application: FilterListsApplyResult | null;
	activeLists: ActiveListSummary[];
	skippedApplication: boolean;
	recoveredPendingSnapshot: boolean;
}

export class ActiveSnapshotCommitError extends Error {
	constructor(
		public readonly application: FilterListsApplyResult,
		cause: unknown
	) {
		super(
			"DNR rules were applied, but the active snapshot " +
				"could not be committed. A pending snapshot remains " +
				"for recovery.",
			{ cause }
		);

		this.name = "ActiveSnapshotCommitError";
	}
}

type FilterListDownloader = Pick<FilterListManager, "refreshAll">;

type FilterListsApplier = Pick<FilterEngineManager, "applyFilterLists">;

interface RecoveredSnapshot {
	records: StoredFilterList[];
	application: FilterListsApplyResult;
}

function getRequiredDefinitions() {
	return FILTER_LISTS.filter(definition => definition.enabledByDefault);
}

function toFilterInputs(
	records: readonly StoredFilterList[]
): FilterListInput[] {
	return records.map(record => ({
		id: record.id,
		content: record.content
	}));
}

function toActiveSummaries(
	records: readonly StoredFilterList[]
): ActiveListSummary[] {
	return records.map(record => ({
		id: record.id,
		version: record.version!,
		sha256: record.sha256
	}));
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Describes restoration from the last verified active snapshot when a forced
 * DNR rebuild cannot refresh the filter lists.
 */
function createActiveSnapshotFallbackReport(
	records: readonly StoredFilterList[],
	reason: string
): FilterListRefreshReport {
	const warning =
		`Filter-list refresh failed: ${reason}. ` +
		"The last verified active snapshot was restored.";

	const lists = records.map(record => {
		const definition = FILTER_LISTS.find(item => item.id === record.id);
		if (!definition) {
			throw new Error(`Unknown active filter list '${record.id}'.`);
		}

		return {
			id: record.id,
			name: definition.name,
			status: "cached" as const,
			version: record.version,
			sha256: record.sha256,
			byteLength: record.byteLength,
			warning
		};
	});

	return {
		lists,
		updatedCount: 0,
		notModifiedCount: 0,
		cachedCount: lists.length
	};
}

function hasSameSnapshots(
	first: readonly StoredFilterList[],
	second: readonly StoredFilterList[]
): boolean {
	if (first.length !== second.length) {
		return false;
	}

	const secondById = new Map(second.map(record => [record.id, record]));

	return first.every(record => {
		const other = secondById.get(record.id);

		return (
			other !== undefined &&
			other.version === record.version &&
			other.sha256 === record.sha256 &&
			other.byteLength === record.byteLength
		);
	});
}

async function calculateSha256(bytes: Uint8Array): Promise<string> {
	const input = new Uint8Array(bytes.byteLength);
	input.set(bytes);

	const digest = await crypto.subtle.digest("SHA-256", input.buffer);

	return Array.from(new Uint8Array(digest))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");
}

export class FilterListSyncManager {
	private syncPromise?: Promise<FilterListSyncResult>;
	/**
	 * Keep a forced rebuild pending until application or journal recovery succeeds.
	 */
	private forceApplyRequested = false;

	constructor(
		private readonly downloader: FilterListDownloader,
		private readonly storage: FilterListStorage,
		private readonly engineManager: FilterListsApplier,
		private readonly now: () => number = Date.now
	) {}

	/**
	 * Concurrent callers share one synchronization operation.
	 */
	sync(options: FilterListSyncOptions = {}): Promise<FilterListSyncResult> {
		if (options.forceApply) {
			this.forceApplyRequested = true;
		}

		if (this.syncPromise) {
			return this.syncPromise;
		}

		const operation = this.runSync();

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

	private async runSync(): Promise<FilterListSyncResult> {
		// Recover a previous interrupted DNR/IndexedDB commit first.
		const recovered = await this.recoverPendingSnapshot();

		let download: FilterListRefreshReport;
		try {
			download = await this.downloader.refreshAll();
		} catch (error: unknown) {
			if (!this.forceApplyRequested) {
				throw error;
			}

			return this.restoreActiveSnapshotAfterRefreshFailure(error, recovered);
		}

		const candidates = await this.loadCandidateRecords(download);

		const active = await this.storage.getAllActive();

		// Avoid reinstalling 5000 rules on every periodic refresh
		// when all list contents are unchanged. An extension update can
		// change compiler behavior without changing the downloaded lists,
		// so it explicitly requests a fresh compilation and DNR replacement.
		const recoveredWithCurrentCompiler = recovered !== null;
		if (
			hasSameSnapshots(candidates, active) &&
			(!this.forceApplyRequested || recoveredWithCurrentCompiler)
		) {
			if (recoveredWithCurrentCompiler) {
				this.forceApplyRequested = false;
			}
			return {
				download,
				application: recovered?.application ?? null,
				activeLists: toActiveSummaries(candidates),
				skippedApplication: true,
				recoveredPendingSnapshot: recovered !== null
			};
		}

		// Stage before touching DNR.
		await this.storage.stageActiveSnapshot(candidates, this.now());

		let application: FilterListsApplyResult;

		try {
			application = await this.engineManager.applyFilterLists(
				toFilterInputs(candidates)
			);
		} catch (error: unknown) {
			try {
				await this.storage.discardPendingActiveSnapshot();
			} catch (cleanupError: unknown) {
				throw new AggregateError(
					[error, cleanupError],
					"DNR application failed and the pending snapshot " +
						"could not be discarded."
				);
			}

			// Existing DNR rules and active snapshots remain unchanged.
			throw error;
		}

		try {
			const committed = await this.storage.commitPendingActiveSnapshot();

			if (!committed) {
				throw new Error("Pending snapshot disappeared before commit.");
			}
		} catch (error: unknown) {
			// DNR succeeded. Leave the journal in place so the next
			// synchronization can finish the active snapshot commit.
			throw new ActiveSnapshotCommitError(application, error);
		}

		// Failures above leave the flag set so a later sync retries the rebuild.
		this.forceApplyRequested = false;

		return {
			download,
			application,
			activeLists: toActiveSummaries(candidates),
			skippedApplication: false,
			recoveredPendingSnapshot: recovered !== null
		};
	}

	/**
	 * Restores the last successfully activated snapshot when a forced DNR
	 * rebuild cannot refresh subscriptions.
	 *
	 * This does not relax the normal stale-cache policy: it only reinstalls
	 * content that was already active and is validated again before use.
	 */
	private async restoreActiveSnapshotAfterRefreshFailure(
		refreshError: unknown,
		recovered: RecoveredSnapshot | null
	): Promise<FilterListSyncResult> {
		let records: StoredFilterList[];
		let application: FilterListsApplyResult;

		if (recovered) {
			// Pending-snapshot recovery has already reapplied these rules and
			// committed the active snapshot using the current compiler.
			records = recovered.records;
			application = recovered.application;
		} else {
			let active: StoredFilterList[];
			try {
				active = await this.storage.getAllActive();
			} catch (error: unknown) {
				throw new AggregateError(
					[refreshError, error],
					"Filter-list refresh failed and the active snapshot could not be loaded."
				);
			}

			// A first installation has no previously active snapshot to restore.
			if (active.length === 0) {
				throw refreshError;
			}

			try {
				records = await this.validateSnapshotRecords(active);
			} catch (error: unknown) {
				throw new AggregateError(
					[refreshError, error],
					"Filter-list refresh failed and the active snapshot could not be validated."
				);
			}

			try {
				application = await this.engineManager.applyFilterLists(
					toFilterInputs(records)
				);
			} catch (error: unknown) {
				throw new AggregateError(
					[refreshError, error],
					"Filter-list refresh failed and managed DNR rules could not be restored."
				);
			}
		}

		this.forceApplyRequested = false;

		return {
			download: createActiveSnapshotFallbackReport(
				records,
				getErrorMessage(refreshError)
			),
			application,
			activeLists: toActiveSummaries(records),
			skippedApplication: recovered !== null,
			recoveredPendingSnapshot: recovered !== null
		};
	}

	/**
	 * Replays an interrupted activation from the durable journal.
	 */
	private async recoverPendingSnapshot(): Promise<RecoveredSnapshot | null> {
		const pending = await this.storage.getPendingActiveSnapshot();

		if (!pending) {
			return null;
		}

		const records = await this.validateSnapshotRecords(pending.records);

		// Do not clear the journal if this fails:
		// DNR may already have been updated before the previous worker stopped.
		const application = await this.engineManager.applyFilterLists(
			toFilterInputs(records)
		);

		try {
			const committed = await this.storage.commitPendingActiveSnapshot();

			if (!committed) {
				throw new Error("Pending snapshot disappeared during recovery.");
			}
		} catch (error: unknown) {
			throw new ActiveSnapshotCommitError(application, error);
		}

		return {
			records,
			application
		};
	}

	/**
	 * Loads and validates the candidate cache produced by the downloader.
	 */
	private async loadCandidateRecords(
		download: FilterListRefreshReport
	): Promise<StoredFilterList[]> {
		const stored = await this.storage.getAll();

		const records = await this.validateSnapshotRecords(stored);

		const downloadedById = new Map(
			download.lists.map(entry => [entry.id, entry])
		);

		for (const record of records) {
			const entry = downloadedById.get(record.id);

			if (
				!entry ||
				entry.version !== record.version ||
				entry.sha256 !== record.sha256 ||
				entry.byteLength !== record.byteLength
			) {
				throw new Error(
					`Downloaded metadata does not match stored list '${record.id}'.`
				);
			}
		}

		return records;
	}

	/**
	 * Validates list identity, size, and checksum before compilation.
	 */
	private async validateSnapshotRecords(
		records: readonly StoredFilterList[]
	): Promise<StoredFilterList[]> {
		const definitions = getRequiredDefinitions();

		const recordsById = new Map<FilterListId, StoredFilterList>();

		for (const record of records) {
			if (recordsById.has(record.id)) {
				throw new Error(`Duplicate stored filter list '${record.id}'.`);
			}

			recordsById.set(record.id, record);
		}

		const validated: StoredFilterList[] = [];

		for (const definition of definitions) {
			const record = recordsById.get(definition.id);

			if (!record) {
				throw new Error(`Missing stored filter list '${definition.id}'.`);
			}

			if (
				record.url !== definition.url ||
				record.title !== definition.expectedTitle ||
				!record.version ||
				!record.content
			) {
				throw new Error(
					`Stored filter list '${definition.id}' has invalid metadata.`
				);
			}

			const bytes = new TextEncoder().encode(record.content);

			if (
				bytes.byteLength !== record.byteLength ||
				bytes.byteLength > definition.maxBytes
			) {
				throw new Error(
					`Stored filter list '${definition.id}' has an invalid size.`
				);
			}

			if (!/^[a-f0-9]{64}$/.test(record.sha256)) {
				throw new Error(
					`Stored filter list '${definition.id}' has an invalid SHA-256.`
				);
			}

			const actualHash = await calculateSha256(bytes);

			if (actualHash !== record.sha256) {
				throw new Error(
					`Stored filter list '${definition.id}' failed SHA-256 validation.`
				);
			}

			validated.push(record);
		}

		return validated;
	}
}
