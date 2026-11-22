import type {
	BrowserContentApi,
	BrowserTab,
	RegisteredContentScript
} from "../shared/browser-content-api.js";

export const COSMETIC_CONTENT_SCRIPT_ID = "block-cosmetic-content";
export const COSMETIC_CONTENT_SCRIPT_FILE = "content.js";

const CONTENT_SCRIPT: Omit<RegisteredContentScript, "matches"> = {
	id: COSMETIC_CONTENT_SCRIPT_ID,
	js: [COSMETIC_CONTENT_SCRIPT_FILE],
	runAt: "document_idle",
	persistAcrossSessions: true,
	allFrames: false
};

export class CosmeticContentScriptManager {
	constructor(
		private readonly api: Pick<BrowserContentApi, "permissions" | "scripting">
	) {}

	/**
	 * Requests access to the active tab's exact host, registers the content
	 * script for future navigations, and injects it into the current document.
	 *
	 * This method calls permissions.request before its first await so callers
	 * can invoke it directly from a user-activation handler.
	 */
	async enableForTab(tab: BrowserTab): Promise<boolean> {
		if (!Number.isInteger(tab.id) || (tab.id ?? -1) < 0 || !tab.url) {
			throw new TypeError("An active tab with an accessible URL is required.");
		}

		const matchPattern = CosmeticContentScriptManager.getOriginMatchPattern(
			tab.url
		);

		if (!matchPattern) {
			throw new TypeError(
				"Cosmetic filtering is supported only on HTTP and HTTPS pages."
			);
		}

		// Keep this call before the first await: browsers require a user gesture.
		const permissionRequest = this.api.permissions.request({
			origins: [matchPattern]
		});
		const granted = await permissionRequest;

		if (!granted) {
			return false;
		}

		await this.registerForMatchPattern(matchPattern);

		await this.api.scripting.executeScript({
			target: { tabId: tab.id! },
			files: [COSMETIC_CONTENT_SCRIPT_FILE]
		});

		return true;
	}

	/**
	 * Builds a match pattern for one hostname and one scheme.
	 *
	 * Match patterns do not distinguish ports, so access is scoped to the
	 * hostname across its ports but never expanded to subdomains.
	 */
	static getOriginMatchPattern(urlValue: string): string | null {
		try {
			const url = new URL(urlValue);

			if (
				(url.protocol !== "http:" && url.protocol !== "https:") ||
				url.username !== "" ||
				url.password !== "" ||
				url.hostname.length === 0 ||
				url.hostname.includes(":")
			) {
				return null;
			}

			return `${url.protocol}//${url.hostname.toLowerCase()}/*`;
		} catch {
			return null;
		}
	}

	private async registerForMatchPattern(matchPattern: string): Promise<void> {
		const [existing] = await this.api.scripting.getRegisteredContentScripts({
			ids: [COSMETIC_CONTENT_SCRIPT_ID]
		});

		if (!existing) {
			await this.api.scripting.registerContentScripts([
				{
					...CONTENT_SCRIPT,
					matches: [matchPattern]
				}
			]);
			return;
		}

		// A user may revoke a previously granted host permission in browser
		// settings. Do not keep that stale match in the next registration update.
		const permittedMatches = await Promise.all(
			existing.matches.map(async match =>
				(await this.api.permissions.contains({ origins: [match] }))
					? match
					: null
			)
		);

		const matches = Array.from(
			new Set([
				...permittedMatches.filter((match): match is string => match !== null),
				matchPattern
			])
		);

		const registrationIsUnchanged =
			matches.length === existing.matches.length &&
			matches.every((match, index) => match === existing.matches[index]);

		if (registrationIsUnchanged) {
			return;
		}

		await this.api.scripting.updateContentScripts([
			{
				id: COSMETIC_CONTENT_SCRIPT_ID,
				matches
			}
		]);
	}
}
