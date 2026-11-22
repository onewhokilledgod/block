import { getBrowserContentApi } from "../shared/browser-content-api.js";
import { CosmeticContentScriptManager } from "../background/cosmetic-content-script-manager.js";

const status = document.querySelector<HTMLParagraphElement>("#status");
const enableButton = document.querySelector<HTMLButtonElement>("#enable-cosmetic");

if (!status || !enableButton) {
	throw new Error("Popup controls were not found.");
}

const api = getBrowserContentApi();
const contentScriptManager = new CosmeticContentScriptManager(api);
let activeTab: { id?: number; url?: string } | undefined;

async function initializePopup(): Promise<void> {
	try {
		const [tab] = await api.tabs.query({ active: true, currentWindow: true });
		activeTab = tab;

		if (!tab?.id || !tab.url) {
			status.textContent = "The current tab is unavailable.";
			return;
		}

		const matchPattern = CosmeticContentScriptManager.getOriginMatchPattern(tab.url);

		if (!matchPattern) {
			status.textContent = "Cosmetic filtering is unavailable on this page.";
			return;
		}

		status.textContent = `Ready to enable cosmetic filtering for ${new URL(tab.url).hostname}.`;
		enableButton.disabled = false;
	} catch (error: unknown) {
		status.textContent = "Could not inspect the current tab.";
		console.error("[Block] Popup initialization failed.", error);
	}
}

enableButton.addEventListener("click", () => {
	if (!activeTab?.id || !activeTab.url) {
		return;
	}

	// The permission request starts directly inside the user click handler.
	enableButton.disabled = true;
	status.textContent = "Requesting access to this site...";

	void contentScriptManager.enableForTab(activeTab).then(
		granted => {
			status.textContent = granted
				? "Cosmetic filtering is enabled for this site."
				: "Site access was not granted.";
			enableButton.disabled = !granted;
		},
		error => {
			status.textContent = "Could not enable cosmetic filtering.";
			enableButton.disabled = false;
			console.error("[Block] Failed to enable cosmetic filtering.", error);
		}
	);
});

void initializePopup();

export {};
