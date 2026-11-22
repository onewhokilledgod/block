import { initializeFilterEngine } from "../shared/filter-engine.js";

import { DnrRulesManager } from "./rules-manager.js";

void initializeFilterEngine()
	.then(async () => {
		const rulesManager = new DnrRulesManager();

		const managedRuleIds = await rulesManager.getManagedRuleIds();

		console.info("[Block] WASM filter engine initialized successfully.");

		console.info(
			`[Block] DNR manager initialized. ` +
				`${managedRuleIds.length} managed dynamic rules installed.`
		);
	})
	.catch((error: unknown) => {
		console.error("[Block] Background initialization failed.", error);
	});
