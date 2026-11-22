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

	constructor(
		private readonly downloader: FilterListDownloader,
		private readonly storage: FilterListStorage,
		private readonly engineManager: FilterListsApplier,
		private readonly now: () => number = Date.now
	) {}

	/**
	 * Concurrent callers share one synchronization operation.
	 */
	sync(): Promise<FilterListSyncResult> {
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

		const download = await this.downloader.refreshAll();

		const candidates = await this.loadCandidateRecords(download);

		const active = await this.storage.getAllActive();

		// Avoid reinstalling 5000 rules on every periodic refresh
		// when all list contents are unchanged.
		if (hasSameSnapshots(candidates, active)) {
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

		return {
			download,
			application,
			activeLists: toActiveSummaries(candidates),
			skippedApplication: false,
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
