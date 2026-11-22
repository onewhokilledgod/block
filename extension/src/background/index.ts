import { initializeFilterEngine } from "../shared/filter-engine.js";

import { DnrRulesManager } from "./rules-manager.js";
import { FilterEngineManager } from "./engine-manager.js";

async function initializeBackground(): Promise<void> {
	const engine = await initializeFilterEngine();

	const rulesManager = new DnrRulesManager();

	const engineManager = new FilterEngineManager(engine, rulesManager);

	const managedRuleIds = await engineManager.getManagedRuleIds();

	console.info("[Block] WASM filter engine initialized successfully.");

	console.info(
		`[Block] DNR manager initialized. ` +
			`${managedRuleIds.length} managed dynamic rules installed.`
	);

	console.info("[Block] Filter engine manager initialized successfully.");
}

void initializeBackground().catch((error: unknown) => {
	console.error("[Block] Background initialization failed.", error);
});
