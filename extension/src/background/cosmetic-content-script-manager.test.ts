import { describe, expect, it, vi } from "vitest";

import type {
	BrowserContentApi,
	RegisteredContentScript
} from "../shared/browser-content-api.js";
import {
	COSMETIC_CONTENT_SCRIPT_FILE,
	COSMETIC_CONTENT_SCRIPT_ID,
	CosmeticContentScriptManager
} from "./cosmetic-content-script-manager.js";

function createApi(options: {
	granted?: boolean;
	registered?: RegisteredContentScript[];
	contains?: (origin: string) => boolean;
} = {}) {
	const registered = options.registered ?? [];

	const permissions = {
		request: vi.fn(async () => options.granted ?? true),
		contains: vi.fn(async ({ origins }: { origins?: string[] }) =>
			options.contains
				? options.contains(origins?.[0] ?? "")
				: options.granted ?? true
		)
	};

	const scripting = {
		getRegisteredContentScripts: vi.fn(async () => registered),
		registerContentScripts: vi.fn(async (scripts: RegisteredContentScript[]) => {
			registered.push(...scripts);
		}),
		updateContentScripts: vi.fn(async () => undefined),
		executeScript: vi.fn(async () => [])
	};

	const api = {
		permissions,
		scripting
	} as unknown as Pick<BrowserContentApi, "permissions" | "scripting">;

	return { api, permissions, scripting, registered };
}

describe("CosmeticContentScriptManager", () => {
	it("creates an exact HTTP or HTTPS host match pattern", () => {
		expect(
			CosmeticContentScriptManager.getOriginMatchPattern(
				"https://News.Example.com:8443/path?q=1"
			)
		).toBe("https://news.example.com/*");

		expect(
			CosmeticContentScriptManager.getOriginMatchPattern(
				"http://example.com/"
			)
		).toBe("http://example.com/*");
	});

	it("rejects non-web pages and URLs containing credentials", () => {
		expect(
			CosmeticContentScriptManager.getOriginMatchPattern("chrome://settings/")
		).toBeNull();
		expect(
			CosmeticContentScriptManager.getOriginMatchPattern("file:///tmp/page.html")
		).toBeNull();
		expect(
			CosmeticContentScriptManager.getOriginMatchPattern(
				"https://user:password@example.com/"
			)
		).toBeNull();
	});

	it("requests only the current host, registers the script and injects it now", async () => {
		const { api, permissions, scripting } = createApi();
		const manager = new CosmeticContentScriptManager(api);

		await expect(
			manager.enableForTab({ id: 17, url: "https://example.com/article" })
		).resolves.toBe(true);

		expect(permissions.request).toHaveBeenCalledWith({
			origins: ["https://example.com/*"]
		});
		expect(scripting.registerContentScripts).toHaveBeenCalledWith([
			expect.objectContaining({
				id: COSMETIC_CONTENT_SCRIPT_ID,
				matches: ["https://example.com/*"],
				js: [COSMETIC_CONTENT_SCRIPT_FILE],
				runAt: "document_idle",
				persistAcrossSessions: true,
				allFrames: false
			})
		]);
		expect(scripting.executeScript).toHaveBeenCalledWith({
			target: { tabId: 17 },
			files: [COSMETIC_CONTENT_SCRIPT_FILE]
		});
	});

	it("does not register or inject when the user denies site access", async () => {
		const { api, scripting } = createApi({ granted: false });
		const manager = new CosmeticContentScriptManager(api);

		await expect(
			manager.enableForTab({ id: 17, url: "https://example.com/" })
		).resolves.toBe(false);

		expect(scripting.registerContentScripts).not.toHaveBeenCalled();
		expect(scripting.executeScript).not.toHaveBeenCalled();
	});

	it("adds a newly granted site to the existing persistent registration", async () => {
		const existing: RegisteredContentScript = {
			id: COSMETIC_CONTENT_SCRIPT_ID,
			matches: ["https://first.example/*"],
			js: [COSMETIC_CONTENT_SCRIPT_FILE],
			runAt: "document_idle",
			persistAcrossSessions: true
		};
		const { api, scripting } = createApi({ registered: [existing] });
		const manager = new CosmeticContentScriptManager(api);

		await manager.enableForTab({ id: 23, url: "https://second.example/" });

		expect(scripting.updateContentScripts).toHaveBeenCalledWith([
			{
				id: COSMETIC_CONTENT_SCRIPT_ID,
				matches: [
					"https://first.example/*",
					"https://second.example/*"
				]
			}
		]);
		expect(scripting.registerContentScripts).not.toHaveBeenCalled();
	});

	it("removes stale matches whose host permission was revoked", async () => {
		const existing: RegisteredContentScript = {
			id: COSMETIC_CONTENT_SCRIPT_ID,
			matches: ["https://revoked.example/*"],
			js: [COSMETIC_CONTENT_SCRIPT_FILE],
			runAt: "document_idle",
			persistAcrossSessions: true
		};
		const { api, scripting } = createApi({
			registered: [existing],
			contains: origin => origin !== "https://revoked.example/*"
		});
		const manager = new CosmeticContentScriptManager(api);

		await manager.enableForTab({ id: 25, url: "https://new.example/" });

		expect(scripting.updateContentScripts).toHaveBeenCalledWith([
			{
				id: COSMETIC_CONTENT_SCRIPT_ID,
				matches: ["https://new.example/*"]
			}
		]);
	});

	it("updates matches when a stale entry is replaced without changing the count", async () => {
		const existing: RegisteredContentScript = {
			id: COSMETIC_CONTENT_SCRIPT_ID,
			matches: ["https://revoked.example/*", "https://still-granted.example/*"],
			js: [COSMETIC_CONTENT_SCRIPT_FILE],
			runAt: "document_idle",
			persistAcrossSessions: true
		};
		const { api, scripting } = createApi({
			registered: [existing],
			contains: origin => origin !== "https://revoked.example/*"
		});
		const manager = new CosmeticContentScriptManager(api);

		await manager.enableForTab({ id: 26, url: "https://new.example/" });

		expect(scripting.updateContentScripts).toHaveBeenCalledWith([
			{
				id: COSMETIC_CONTENT_SCRIPT_ID,
				matches: [
					"https://still-granted.example/*",
					"https://new.example/*"
				]
			}
		]);
	});

	it("does not duplicate an already registered match pattern", async () => {
		const existing: RegisteredContentScript = {
			id: COSMETIC_CONTENT_SCRIPT_ID,
			matches: ["https://example.com/*"],
			js: [COSMETIC_CONTENT_SCRIPT_FILE],
			runAt: "document_idle",
			persistAcrossSessions: true
		};
		const { api, scripting } = createApi({ registered: [existing] });
		const manager = new CosmeticContentScriptManager(api);

		await manager.enableForTab({ id: 24, url: "https://example.com/" });

		expect(scripting.updateContentScripts).not.toHaveBeenCalled();
	});

	it("rejects a tab without a usable ID or URL", async () => {
		const { api } = createApi();
		const manager = new CosmeticContentScriptManager(api);

		await expect(manager.enableForTab({ url: "https://example.com/" })).rejects.toThrow(
			TypeError
		);
		await expect(manager.enableForTab({ id: 1 })).rejects.toThrow(TypeError);
	});
});
