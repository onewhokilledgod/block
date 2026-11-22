import { initializeFilterEngine } from "../shared/filter-engine.js";

void initializeFilterEngine()
	.then(() => {
		console.info("[Block] WASM filter engine initialized successfully.");
	})
	.catch((error: unknown) => {
		console.error("[Block] Failed to initialize WASM filter engine.", error);
	});
