import { initializeFilterEngine } from "../../extension/src/shared/filter-engine.js";
import type { FilterEngine } from "../../extension/src/shared/filter-engine.js";
import { CosmeticContentRuntime } from "../../extension/src/background/cosmetic-content-runtime.js";
import { DnrRulesManager } from "../../extension/src/background/rules-manager.js";
import { getBrowserContentApi } from "../../extension/src/shared/browser-content-api.js";

const READY_MESSAGE = "block-e2e-ready";

const FILTER_LIST = [
	"[Adblock Plus 2.0]",
	"||127.0.0.1*/ads/$script",
	"@@||127.0.0.1*/ads/allowed.js$script",
	"||127.0.0.1*/scoped/domain.js$script,domain=localhost",
	"##.e2e-ad"
].join("\n");

const browserApi = getBrowserContentApi();
const enginePromise = initializeFilterEngine();

const cosmeticRuntime = new CosmeticContentRuntime(
	async () => {
		const filterEngine = await enginePromise;

		return {
			storage: {
				getAllActive: async () => [
					{
						id: "browser-e2e",
						sha256: "browser-e2e-fixture",
						content: FILTER_LIST
					}
				]
			},
			filterEngine: filterEngine as Pick<FilterEngine, "parseFilterList">
		};
	},
	browserApi
);

// Register the production cosmetic message handlers synchronously, just as
// the real background entry point does during extension startup.
cosmeticRuntime.registerListeners();

const readyPromise = (async (): Promise<void> => {
	const filterEngine = await enginePromise;
	const report = filterEngine.compileFilterList(FILTER_LIST, {
		maxRules: 100,
		maxRegexRules: 100,
		firstRuleId: 1
	});

	if (
		report.compilerStats.skippedNetworkFilters !== 0 ||
		report.rules.length !== 3
	) {
		throw new Error(
			"The browser E2E filter fixture did not compile as expected: " +
			JSON.stringify(report.compilerDiagnostics)
		);
	}

	const rulesManager = new DnrRulesManager();
	const result = await rulesManager.replaceManagedRules(report.rules);

	if (result.installedCount !== 3) {
		throw new Error(
			`Expected to install 3 DNR rules; installed ${result.installedCount}.`
		);
	}
})();

browserApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (
		!message ||
		typeof message !== "object" ||
		(message as { type?: unknown }).type !== READY_MESSAGE
	) {
		return false;
	}

	void readyPromise.then(
		() => sendResponse({ ok: true }),
		error =>
			sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			})
	);

	return true;
});
