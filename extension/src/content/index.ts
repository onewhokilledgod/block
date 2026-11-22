import { CosmeticDomObserver } from "./cosmetic-dom-observer.js";
import {
	startCosmeticContentScript,
	type CosmeticContentScriptLifecycleState
} from "./cosmetic-content-script-lifecycle.js";
import { CosmeticSelectorProcessor } from "../cosmetic/cosmetic-selector-processor.js";
import { getBrowserRuntimeApi } from "../shared/browser-content-api.js";
import {
	APPLY_COSMETIC_CSS_MESSAGE,
	GET_COSMETIC_SELECTORS_MESSAGE,
	isApplyCosmeticCssResponse,
	isCosmeticSelectorsResponse
} from "../shared/cosmetic-messages.js";

type ContentScriptGlobal = typeof globalThis &
	CosmeticContentScriptLifecycleState & {
		__blockCosmeticDomObserver?: CosmeticDomObserver;
	};

async function applyCosmeticFiltering(): Promise<boolean> {
	if (window.top !== window) {
		return false;
	}

	const runtime = getBrowserRuntimeApi();
	const selectorsResponse = await runtime.sendMessage({
		type: GET_COSMETIC_SELECTORS_MESSAGE
	});

	if (
		!isCosmeticSelectorsResponse(selectorsResponse) ||
		!selectorsResponse.ok ||
		selectorsResponse.selectors.length === 0
	) {
		return false;
	}

	const result = new CosmeticSelectorProcessor().process(
		selectorsResponse.selectors
	);

	if (result.cssText.length === 0) {
		if (result.diagnostics.length > 0) {
			console.warn(
				"[Block] No valid cosmetic selectors were found.",
				result.diagnostics
			);
		}

		return false;
	}

	const applyResponse = await runtime.sendMessage({
		type: APPLY_COSMETIC_CSS_MESSAGE,
		cssText: result.cssText
	});

	if (!isApplyCosmeticCssResponse(applyResponse) || !applyResponse.ok) {
		console.warn(
			"[Block] Could not apply cosmetic CSS.",
			isApplyCosmeticCssResponse(applyResponse)
				? applyResponse.error
				: "Invalid background response."
		);
		return false;
	}

	// A document-level user stylesheet automatically covers ordinary DOM
	// nodes inserted later. MutationObserver is needed here only for open
	// Shadow DOM, which has a separate CSS scope.
	try {
		const observer = new CosmeticDomObserver();
		observer.start(result.cssText);
		contentScriptGlobal.__blockCosmeticDomObserver = observer;
	} catch (error: unknown) {
		console.warn(
			"[Block] Could not enable dynamic Shadow DOM filtering.",
			error
		);
	}

	if (result.diagnostics.length > 0) {
		console.info(
			`[Block] Applied ${result.selectors.length} cosmetic selectors; ` +
				`${result.diagnostics.length} selectors were skipped.`,
			result.diagnostics
		);
	}

	return true;
}

const contentScriptGlobal = globalThis as ContentScriptGlobal;

// `executeScript()` may run more than once in the same document. Coalesce
// concurrent attempts and mark the document initialized only after CSS applies.
startCosmeticContentScript(
	contentScriptGlobal,
	applyCosmeticFiltering,
	error => {
		console.error("[Block] Cosmetic content script failed.", error);
	}
);
