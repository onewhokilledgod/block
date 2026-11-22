import {
	FILTER_LISTS,
	FILTER_LIST_FETCH_TIMEOUT_MS,
	MIN_FILTER_LINES,
	type FilterListDefinition,
	type FilterListId
} from "./filter-lists.js";

import {
	FilterListStorage,
	type StoredFilterList
} from "./filter-list-storage.js";

export type FilterListRefreshStatus = "updated" | "not-modified" | "cached";

export interface FilterListRefreshEntry {
	id: FilterListId;
	name: string;
	status: FilterListRefreshStatus;
	version: string | null;
	sha256: string;
	byteLength: number;
	warning?: string;
}

export interface FilterListRefreshReport {
	lists: FilterListRefreshEntry[];
	updatedCount: number;
	notModifiedCount: number;
	cachedCount: number;
}

export interface FilterListFailure {
	id: FilterListId;
	reason: string;
}

export class FilterListRefreshError extends Error {
	constructor(public readonly failures: FilterListFailure[]) {
		super(
			"Unable to refresh all required filter lists: " +
				failures.map(failure => `${failure.id}: ${failure.reason}`).join("; ")
		);

		this.name = "FilterListRefreshError";
	}
}

export interface FilterListManagerOptions {
	fetcher?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
}

interface ListMetadata {
	version: string;
}

interface SuccessfulOutcome {
	definition: FilterListDefinition;
	status: FilterListRefreshStatus;
	record: StoredFilterList;
	persist: boolean;
	warning?: string;
}

interface FailedOutcome {
	definition: FilterListDefinition;
	status: "failed";
	reason: string;
}

type FetchOutcome = SuccessfulOutcome | FailedOutcome;

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseListMetadata(
	content: string,
	definition: FilterListDefinition
): ListMetadata {
	const normalizedContent = content.replace(/^\uFEFF/, "");
	const lines = normalizedContent.split(/\r\n|\n|\r/);

	const header = lines.find(line => line.trim().length > 0)?.trim();

	if (!header || !/^\[Adblock Plus \d+\.\d+\]$/.test(header)) {
		throw new Error("Invalid or missing Adblock Plus list header.");
	}

	const titleLine = lines.find(line => /^!\s*Title\s*:/i.test(line.trim()));

	const title = titleLine
		?.trim()
		.replace(/^!\s*Title\s*:\s*/i, "")
		.trim();

	if (
		!title ||
		title.toLowerCase() !== definition.expectedTitle.toLowerCase()
	) {
		throw new Error(
			`Unexpected list title: ${title ?? "missing"}. ` +
				`Expected: ${definition.expectedTitle}.`
		);
	}

	const versionLine = lines.find(line => /^!\s*Version\s*:/i.test(line.trim()));

	const version = versionLine
		?.trim()
		.replace(/^!\s*Version\s*:\s*/i, "")
		.trim();

	if (!version || version.length > 128) {
		throw new Error("Invalid or missing list version.");
	}

	const filterLineCount = lines.filter(line => {
		const trimmed = line.trim();

		return (
			trimmed.length > 0 &&
			!trimmed.startsWith("!") &&
			!/^\[Adblock Plus \d+\.\d+\]$/.test(trimmed)
		);
	}).length;

	if (filterLineCount < MIN_FILTER_LINES) {
		throw new Error(
			`The list contains too few filter lines: ` +
				`${filterLineCount}. Minimum: ${MIN_FILTER_LINES}.`
		);
	}

	return { version };
}

function assertContentLength(response: Response, maxBytes: number): void {
	const value = response.headers.get("Content-Length");

	if (value === null) {
		return;
	}

	if (!/^\d+$/.test(value)) {
		throw new Error("Invalid Content-Length header.");
	}

	const length = Number(value);

	if (!Number.isSafeInteger(length)) {
		throw new Error("Invalid response size.");
	}

	if (length > maxBytes) {
		throw new RangeError(
			`Filter list exceeds the maximum size of ${maxBytes} bytes.`
		);
	}
}

async function readResponseBytes(
	response: Response,
	maxBytes: number
): Promise<Uint8Array> {
	assertContentLength(response, maxBytes);

	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());

		if (bytes.byteLength > maxBytes) {
			throw new RangeError("Filter list is too large.");
		}

		return bytes;
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];

	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			totalBytes += value.byteLength;

			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => undefined);

				throw new RangeError(`Filter list exceeds ${maxBytes} bytes.`);
			}

			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const result = new Uint8Array(totalBytes);

	let offset = 0;

	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return result;
}

async function calculateSha256(bytes: Uint8Array): Promise<string> {
	const input = new Uint8Array(bytes.byteLength);
	input.set(bytes);

	const digest = await globalThis.crypto.subtle.digest("SHA-256", input.buffer);

	return Array.from(new Uint8Array(digest))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");
}

export class FilterListManager {
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	private readonly timeoutMs: number;

	constructor(
		private readonly storage: FilterListStorage,
		options: FilterListManagerOptions = {}
	) {
		this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
		this.now = options.now ?? Date.now;

		this.timeoutMs = options.timeoutMs ?? FILTER_LIST_FETCH_TIMEOUT_MS;

		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new RangeError("Invalid fetch timeout.");
		}
	}

	/**
	 * Refreshes all required lists.
	 *
	 * No new cache records are written until every required
	 * list has a valid fresh or previously cached version.
	 */
	async refreshAll(): Promise<FilterListRefreshReport> {
		const outcomes = await Promise.all(
			FILTER_LISTS.map(async definition => {
				const stored = await this.storage.get(definition.id);

				const cached = await this.validateCachedRecord(definition, stored);

				return this.fetchList(definition, cached);
			})
		);

		const failures = outcomes.filter(
			(outcome): outcome is FailedOutcome => outcome.status === "failed"
		);

		if (failures.length > 0) {
			throw new FilterListRefreshError(
				failures.map(failure => ({
					id: failure.definition.id,
					reason: failure.reason
				}))
			);
		}

		const successful = outcomes as SuccessfulOutcome[];

		const recordsToSave = successful
			.filter(outcome => outcome.persist)
			.map(outcome => outcome.record);

		// One IndexedDB transaction for all new records.
		await this.storage.putMany(recordsToSave);

		const lists: FilterListRefreshEntry[] = successful.map(outcome => ({
			id: outcome.definition.id,
			name: outcome.definition.name,
			status: outcome.status,
			version: outcome.record.version,
			sha256: outcome.record.sha256,
			byteLength: outcome.record.byteLength,
			...(outcome.warning ? { warning: outcome.warning } : {})
		}));

		return {
			lists,
			updatedCount: successful.filter(item => item.status === "updated").length,
			notModifiedCount: successful.filter(
				item => item.status === "not-modified"
			).length,
			cachedCount: successful.filter(item => item.status === "cached").length
		};
	}

	/**
	 * Ensures cached data is valid before using it as fallback.
	 */
	private async validateCachedRecord(
		definition: FilterListDefinition,
		record: StoredFilterList | null
	): Promise<StoredFilterList | null> {
		if (!record) {
			return null;
		}

		try {
			if (
				record.id !== definition.id ||
				record.url !== definition.url ||
				record.title !== definition.expectedTitle
			) {
				return null;
			}

			const bytes = new TextEncoder().encode(record.content);

			if (
				bytes.byteLength !== record.byteLength ||
				bytes.byteLength > definition.maxBytes
			) {
				return null;
			}

			const hash = await calculateSha256(bytes);

			if (hash !== record.sha256) {
				return null;
			}

			const metadata = parseListMetadata(record.content, definition);

			if (metadata.version !== record.version) {
				return null;
			}

			return record;
		} catch {
			return null;
		}
	}

	private async fetchList(
		definition: FilterListDefinition,
		cached: StoredFilterList | null
	): Promise<FetchOutcome> {
		const controller = new AbortController();

		let timedOut = false;

		const timeoutId = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);

		try {
			const headers = new Headers({
				Accept: "text/plain"
			});

			const response = await this.fetcher(definition.url, {
				method: "GET",
				headers,
				signal: controller.signal,
				cache: "no-store",
				credentials: "omit",
				redirect: "follow",
				referrerPolicy: "no-referrer"
			});

			if (response.status === 304) {
				if (!cached) {
					throw new Error("Server returned 304 but no valid cache exists.");
				}

				const record: StoredFilterList = {
					...cached,
					etag: response.headers.get("ETag") ?? cached.etag,
					lastModified:
						response.headers.get("Last-Modified") ?? cached.lastModified,
					checkedAt: this.now()
				};

				return {
					definition,
					status: "not-modified",
					record,
					persist: true
				};
			}

			if (response.status !== 200) {
				throw new Error(`HTTP request failed with status ${response.status}.`);
			}

			// Do not silently accept a redirect to an unrelated host.
			if (response.url) {
				const originalOrigin = new URL(definition.url).origin;

				const responseOrigin = new URL(response.url).origin;

				if (responseOrigin !== originalOrigin) {
					throw new Error("Filter list redirected to an untrusted origin.");
				}
			}

			const bytes = await readResponseBytes(response, definition.maxBytes);

			let content: string;

			try {
				content = new TextDecoder("utf-8", {
					fatal: true,
					ignoreBOM: true
				}).decode(bytes);
			} catch {
				throw new Error("Filter list is not valid UTF-8.");
			}

			const metadata = parseListMetadata(content, definition);

			const sha256 = await calculateSha256(bytes);
			const timestamp = this.now();

			const record: StoredFilterList = {
				id: definition.id,
				url: definition.url,
				title: definition.expectedTitle,
				version: metadata.version,
				etag: response.headers.get("ETag"),
				lastModified: response.headers.get("Last-Modified"),
				sha256,
				byteLength: bytes.byteLength,
				content,
				fetchedAt: timestamp,
				checkedAt: timestamp
			};

			return {
				definition,
				status: "updated",
				record,
				persist: true
			};
		} catch (error: unknown) {
			const reason = timedOut
				? `Request timed out after ${this.timeoutMs} ms.`
				: getErrorMessage(error);

			if (cached) {
				return {
					definition,
					status: "cached",
					record: cached,
					persist: false,
					warning: reason
				};
			}

			return {
				definition,
				status: "failed",
				reason
			};
		} finally {
			clearTimeout(timeoutId);
		}
	}
}
