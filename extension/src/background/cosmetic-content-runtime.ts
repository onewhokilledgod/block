import type { FilterEngine, CosmeticFilter } from "../shared/filter-engine.js";
import {
	APPLY_COSMETIC_CSS_MESSAGE,
	GET_COSMETIC_SELECTORS_MESSAGE
} from "../shared/cosmetic-messages.js";

import { CosmeticRuleEngine } from "../cosmetic/cosmetic-rule-engine.js";
import {
	CosmeticContentScriptManager
} from "./cosmetic-content-script-manager.js";
import {
	getBrowserContentApi,
	type BrowserContentApi,
	type BrowserMessageSender
} from "../shared/browser-content-api.js";

const MAX_COSMETIC_CSS_LENGTH = 16_000_000;

export interface CosmeticContentServices {
	storage: {
		getAllActive(): Promise<
			Array<{ id: string; sha256: string; content: string }>
		>;
	};
	filterEngine: Pick<FilterEngine, "parseFilterList">;
}

interface TrustedPageContext {
	tabId: number;
	url: URL;
}

function isMessageType(
	message: unknown,
	type: string
): message is Record<string, unknown> {
	return (
		!!message &&
		typeof message === "object" &&
		(message as Record<string, unknown>).type === type
	);
}

/**
 * Handles the content-script/background handshake for cosmetic filtering.
 *
 * The page-side script validates CSS selectors. The background worker applies
 * the resulting CSS with scripting.insertCSS, which is not subject to the
 * document's inline-style CSP restrictions.
 */
export class CosmeticContentRuntime {
	private listenersRegistered = false;

	private cachedCosmeticEngine?: {
		fingerprint: string;
		engine: CosmeticRuleEngine;
	};

	constructor(
		private readonly getServices: () => Promise<CosmeticContentServices>,
		private readonly api: Pick<
			BrowserContentApi,
			"runtime" | "permissions" | "scripting"
		> = getBrowserContentApi()
	) {}

	/** Must be called synchronously while the background worker is starting. */
	registerListeners(): void {
		if (this.listenersRegistered) {
			return;
		}

		this.listenersRegistered = true;

		this.api.runtime.onMessage.addListener(
			(message, sender, sendResponse) => {
				if (isMessageType(message, GET_COSMETIC_SELECTORS_MESSAGE)) {
					void this.getSelectors(sender).then(
						selectors => sendResponse({ ok: true, selectors }),
						error =>
							sendResponse({
								ok: false,
								selectors: [],
								error: this.errorMessage(error)
							})
					);

					return true;
				}

				if (isMessageType(message, APPLY_COSMETIC_CSS_MESSAGE)) {
					void this.applyCss(message.cssText, sender).then(
						() => sendResponse({ ok: true }),
						error =>
							sendResponse({
								ok: false,
								error: this.errorMessage(error)
							})
					);

					return true;
				}

				return false;
			}
		);
	}

	private async getSelectors(sender: BrowserMessageSender): Promise<string[]> {
		const page = await this.getTrustedPageContext(sender);

		if (!page) {
			return [];
		}

		const services = await this.getServices();
		const activeLists = await services.storage.getAllActive();
		const fingerprint = JSON.stringify(
			activeLists.map(list => [list.id, list.sha256])
		);

		let cachedEngine = this.cachedCosmeticEngine;

		if (!cachedEngine || cachedEngine.fingerprint !== fingerprint) {
			const cosmeticFilters: CosmeticFilter[] = [];

			for (const list of activeLists) {
				const report = services.filterEngine.parseFilterList(list.content);

				for (const filter of report.filters) {
					if (filter.kind === "cosmetic") {
						cosmeticFilters.push(filter);
					}
				}
			}

			cachedEngine = {
				fingerprint,
				engine: new CosmeticRuleEngine(cosmeticFilters)
			};
			this.cachedCosmeticEngine = cachedEngine;
		}

		return cachedEngine.engine.getSelectorsForHostname(page.url.hostname);
	}

	private async applyCss(
		cssText: unknown,
		sender: BrowserMessageSender
	): Promise<void> {
		if (
			typeof cssText !== "string" ||
			cssText.length === 0 ||
			cssText.length > MAX_COSMETIC_CSS_LENGTH
		) {
			throw new TypeError("Cosmetic CSS payload is invalid or too large.");
		}

		const page = await this.getTrustedPageContext(sender);

		if (!page) {
			throw new Error("The sender does not have access to this page.");
		}

		await this.api.scripting.insertCSS({
			target: { tabId: page.tabId, frameIds: [0] },
			css: cssText,
			origin: "USER"
		});
	}

	private async getTrustedPageContext(
		sender: BrowserMessageSender
	): Promise<TrustedPageContext | null> {
		const tabId = sender.tab?.id;

		if (!Number.isInteger(tabId) || (tabId ?? -1) < 0 || sender.frameId !== 0) {
			return null;
		}

		let url: URL;

		try {
			url = new URL(sender.url ?? "");
		} catch {
			return null;
		}

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return null;
		}

		const matchPattern =
			CosmeticContentScriptManager.getOriginMatchPattern(url.toString());

		if (!matchPattern) {
			return null;
		}

		const hasHostPermission = await this.api.permissions.contains({
			origins: [matchPattern]
		});

		if (!hasHostPermission) {
			return null;
		}

		return { tabId: tabId!, url };
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error
			? error.message
			: "Cosmetic filtering request failed.";
	}
}
