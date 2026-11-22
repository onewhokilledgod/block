import { getBrowserContentApi } from "../shared/browser-content-api.js";
import { CosmeticContentScriptManager } from "../background/cosmetic-content-script-manager.js";

const status = document.querySelector<HTMLParagraphElement>("#status");
const enableButton = document.querySelector<HTMLButtonElement>("#enable-cosmetic");

if (!status || !enableButton) {
	throw new Error("Popup controls were not found.");
}

// Capture the non-null DOM references after the runtime guard. TypeScript
// does not retain the narrowing of the original variables inside callbacks.
const popupStatus: HTMLParagraphElement = status;
const popupEnableButton: HTMLButtonElement = enableButton;

const api = getBrowserContentApi();
const contentScriptManager = new CosmeticContentScriptManager(api);
let activeTab: { id?: number; url?: string } | undefined;

async function initializePopup(): Promise<void> {
	try {
		const [tab] = await api.tabs.query({ active: true, currentWindow: true });
		activeTab = tab;

		if (!tab?.id || !tab.url) {
			popupStatus.textContent = "The current tab is unavailable.";
			return;
		}

		const matchPattern = CosmeticContentScriptManager.getOriginMatchPattern(tab.url);

		if (!matchPattern) {
			popupStatus.textContent = "Cosmetic filtering is unavailable on this page.";
			return;
		}

		popupStatus.textContent = `Ready to enable cosmetic filtering for ${new URL(tab.url).hostname}.`;
		popupEnableButton.disabled = false;
	} catch (error: unknown) {
		popupStatus.textContent = "Could not inspect the current tab.";
		console.error("[Block] Popup initialization failed.", error);
	}
}

popupEnableButton.addEventListener("click", () => {
	if (!activeTab?.id || !activeTab.url) {
		return;
	}

	// The permission request starts directly inside the user click handler.
	popupEnableButton.disabled = true;
	popupStatus.textContent = "Requesting access to this site...";

	void contentScriptManager.enableForTab(activeTab).then(
		granted => {
			popupStatus.textContent = granted
				? "Cosmetic filtering is enabled for this site."
				: "Site access was not granted.";
			popupEnableButton.disabled = !granted;
		},
		error => {
			popupStatus.textContent = "Could not enable cosmetic filtering.";
			popupEnableButton.disabled = false;
			console.error("[Block] Failed to enable cosmetic filtering.", error);
		}
	);
});

void initializePopup();

export {};
