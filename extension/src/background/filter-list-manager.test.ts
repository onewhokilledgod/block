import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	FILTER_LISTS,
	MIN_FILTER_LINES,
	type FilterListId
} from "./filter-lists.js";

import {
	FilterListStorage,
	type StoredFilterList
} from "./filter-list-storage.js";

import {
	FilterListManager,
	FilterListRefreshError
} from "./filter-list-manager.js";

let storage: FilterListStorage;
let databaseCounter = 0;

function createListContent(title: string): string {
	const header =
		title === "EasyPrivacy" ? "[Adblock Plus 1.1]" : "[Adblock Plus 2.0]";

	const rules = Array.from(
		{ length: MIN_FILTER_LINES + 10 },
		(_, index) => `||tracker-${index}.${title.toLowerCase()}.example^`
	);

	return [
		header,
		"! Version: 202611220954",
		`! Title: ${title}`,
		"! Last modified: 22 Nov 2026 09:54 UTC",
		"! Expires: 4 days (update frequency)",
		...rules
	].join("\n");
}

async function createStoredRecord(id: FilterListId): Promise<StoredFilterList> {
	const definition = FILTER_LISTS.find(item => item.id === id)!;

	const content = createListContent(definition.expectedTitle);

	const bytes = new TextEncoder().encode(content);

	const digest = await crypto.subtle.digest("SHA-256", bytes);

	const sha256 = Array.from(new Uint8Array(digest))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");

	return {
		id,
		url: definition.url,
		title: definition.expectedTitle,
		version: "202611220954",
		etag: `"${id}-etag"`,
		lastModified: "Sun, 22 Nov 2026 09:54:00 GMT",
		sha256,
		byteLength: bytes.byteLength,
		content,
		fetchedAt: 1000,
		checkedAt: 1000
	};
}

function createFetcher(
	handler: (url: string, init?: RequestInit) => Promise<Response>
): typeof fetch {
	return async (input, init) => handler(String(input), init);
}

function createResponse(
	title: string,
	extraHeaders: Record<string, string> = {}
): Response {
	return new Response(createListContent(title), {
		status: 200,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			ETag: '"new-version"',
			"Last-Modified": "Mon, 23 Nov 2026 09:00:00 GMT",
			...extraHeaders
		}
	});
}

beforeEach(() => {
	databaseCounter += 1;

	storage = new FilterListStorage(
		`block-filter-manager-test-${databaseCounter}`
	);
});

afterEach(() => {
	storage.close();
});

describe("FilterListManager", () => {
	it("downloads, validates and stores both filter lists", async () => {
		const fetcher = createFetcher(async url => {
			const title = url.includes("easyprivacy") ? "EasyPrivacy" : "EasyList";

			return createResponse(title);
		});

		const manager = new FilterListManager(storage, {
			fetcher,
			now: () => 2000
		});

		const report = await manager.refreshAll();

		expect(report.updatedCount).toBe(2);
		expect(report.cachedCount).toBe(0);

		const records = await storage.getAll();

		expect(records).toHaveLength(2);

		for (const record of records) {
			expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(record.byteLength).toBeGreaterThan(0);
			expect(record.checkedAt).toBe(2000);
		}
	});

	it("uses conditional requests and handles HTTP 304", async () => {
		const records = await Promise.all([
			createStoredRecord("easylist"),
			createStoredRecord("easyprivacy")
		]);

		await storage.putMany(records);

		const fetcher = createFetcher(async (_url, init) => {
			const headers = new Headers(init?.headers);

			expect(headers.get("If-None-Match")).not.toBeNull();

			expect(headers.get("If-Modified-Since")).not.toBeNull();

			return new Response(null, {
				status: 304,
				headers: {
					ETag: '"unchanged"'
				}
			});
		});

		const manager = new FilterListManager(storage, {
			fetcher,
			now: () => 3000
		});

		const report = await manager.refreshAll();

		expect(report.notModifiedCount).toBe(2);

		const stored = await storage.getAll();

		for (const record of stored) {
			expect(record.checkedAt).toBe(3000);
			expect(record.fetchedAt).toBe(1000);
			expect(record.etag).toBe('"unchanged"');
		}
	});

	it("keeps the cached version when a new list is invalid", async () => {
		const records = await Promise.all([
			createStoredRecord("easylist"),
			createStoredRecord("easyprivacy")
		]);

		await storage.putMany(records);

		const fetcher = createFetcher(async url => {
			if (url.includes("easyprivacy")) {
				return createResponse("EasyPrivacy");
			}

			return createResponse("UnexpectedList");
		});

		const manager = new FilterListManager(storage, {
			fetcher
		});

		const report = await manager.refreshAll();

		expect(report.cachedCount).toBe(1);
		expect(report.updatedCount).toBe(1);

		const cached = await storage.get("easylist");

		expect(cached?.content).toBe(records[0].content);

		const updated = await storage.get("easyprivacy");

		expect(updated?.version).toBe("202611220954");
	});

	it("does not persist a partial update when a required list has no valid cache", async () => {
		const fetcher = createFetcher(async url => {
			if (url.includes("easyprivacy")) {
				return createResponse("UnexpectedList");
			}

			return createResponse("EasyList");
		});

		const manager = new FilterListManager(storage, {
			fetcher
		});

		await expect(manager.refreshAll()).rejects.toBeInstanceOf(
			FilterListRefreshError
		);

		await expect(storage.getAll()).resolves.toHaveLength(0);
	});

	it("uses the cache when a response exceeds the size limit", async () => {
		const records = await Promise.all([
			createStoredRecord("easylist"),
			createStoredRecord("easyprivacy")
		]);

		await storage.putMany(records);

		const fetcher = createFetcher(async url => {
			if (url.includes("easyprivacy")) {
				return new Response("Unavailable", {
					status: 503
				});
			}

			const definition = FILTER_LISTS.find(item => item.id === "easylist")!;

			return new Response("x", {
				status: 200,
				headers: {
					"Content-Length": String(definition.maxBytes + 1)
				}
			});
		});

		const manager = new FilterListManager(storage, {
			fetcher
		});

		const report = await manager.refreshAll();

		expect(report.cachedCount).toBe(2);

		const stored = await storage.getAll();

		expect(stored[0].sha256).toBe(records[0].sha256);
		expect(stored[1].sha256).toBe(records[1].sha256);
	});

	it("falls back to valid cached lists after a timeout", async () => {
		const records = await Promise.all([
			createStoredRecord("easylist"),
			createStoredRecord("easyprivacy")
		]);

		await storage.putMany(records);

		const fetcher = createFetcher(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;

					const abort = () => {
						reject(new DOMException("Request aborted", "AbortError"));
					};

					if (signal?.aborted) {
						abort();
						return;
					}

					signal?.addEventListener("abort", abort, { once: true });
				})
		);

		const manager = new FilterListManager(storage, {
			fetcher,
			timeoutMs: 10
		});

		const report = await manager.refreshAll();

		expect(report.cachedCount).toBe(2);

		expect(
			report.lists.every(item => item.warning?.includes("timed out"))
		).toBe(true);
	});
});
