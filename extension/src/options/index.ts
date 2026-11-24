import "./options.css";

import { FilterListStorage, type StoredFilterList } from "../background/filter-list-storage.js";
import {
	normalizeCustomFilterListUrl,
	type StoredFilterListSubscription
} from "../background/filter-list-subscriptions.js";
import type { UserSettings, UserSettingsPatch } from "../background/user-settings.js";
import { getBrowserContentApi } from "../shared/browser-content-api.js";
import { REFRESH_FILTER_LISTS_MESSAGE } from "../shared/options-messages.js";

const storage = new FilterListStorage();
const api = getBrowserContentApi();

function requiredElement<T extends HTMLElement>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (!element) {
		throw new Error(`Options page element '${selector}' was not found.`);
	}
	return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const statusElement = requiredElement<HTMLParagraphElement>("#page-status");
const networkToggle = requiredElement<HTMLInputElement>("#network-filtering");
const cosmeticToggle = requiredElement<HTMLInputElement>("#cosmetic-filtering");
const automaticUpdatesToggle = requiredElement<HTMLInputElement>("#automatic-updates");
const intervalSelect = requiredElement<HTMLSelectElement>("#update-interval");
const themeSelect = requiredElement<HTMLSelectElement>("#theme");
const subscriptionList = requiredElement<HTMLDivElement>("#subscription-list");
const addSubscriptionForm = requiredElement<HTMLFormElement>("#add-subscription-form");
const subscriptionNameInput = requiredElement<HTMLInputElement>("#subscription-name");
const subscriptionUrlInput = requiredElement<HTMLInputElement>("#subscription-url");
const refreshButton = requiredElement<HTMLButtonElement>("#refresh-lists");
const resetButton = requiredElement<HTMLButtonElement>("#reset-settings");

let settings: UserSettings;
let subscriptions: StoredFilterListSubscription[] = [];
let cachedLists = new Map<string, StoredFilterList>();
let pageReady = false;
const pageControls = Array.from(
	document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
		"input, select, button"
	)
);
for (const control of pageControls) {
	control.disabled = true;
}

function setStatus(message: string, tone: "neutral" | "success" | "error" = "neutral"): void {
	statusElement.textContent = message;
	statusElement.dataset.tone = tone;
}

function applyTheme(theme: UserSettings["theme"]): void {
	document.documentElement.dataset.theme = theme;
}

function renderSettings(): void {
	networkToggle.checked = settings.networkFilteringEnabled;
	cosmeticToggle.checked = settings.cosmeticFilteringEnabled;
	automaticUpdatesToggle.checked = settings.automaticFilterListUpdatesEnabled;
	intervalSelect.value = String(settings.filterListUpdateIntervalMinutes);
	intervalSelect.disabled = !settings.automaticFilterListUpdatesEnabled;
	themeSelect.value = settings.theme;
	applyTheme(settings.theme);
}

async function saveSettings(patch: UserSettingsPatch): Promise<void> {
	const previous = settings;
	try {
		settings = await storage.updateUserSettings(patch);
		renderSettings();
		setStatus("Preference saved.", "success");
	} catch (error: unknown) {
		settings = previous;
		renderSettings();
		setStatus(error instanceof Error ? error.message : "Could not save preference.", "error");
	}
}

function formatLastChecked(record: StoredFilterList | undefined): string {
	if (!record || !Number.isFinite(record.checkedAt)) {
		return "Not downloaded yet";
	}
	return `Last checked ${new Date(record.checkedAt).toLocaleString()}`;
}

function renderSubscriptions(): void {
	subscriptionList.replaceChildren();

	if (subscriptions.length === 0) {
		const empty = document.createElement("p");
		empty.className = "muted";
		empty.textContent = "No filter lists have been added.";
		subscriptionList.append(empty);
		return;
	}

	for (const subscription of subscriptions) {
		const card = document.createElement("article");
		card.className = "subscription-card";

		const top = document.createElement("div");
		top.className = "subscription-top";

		const details = document.createElement("div");
		const title = document.createElement("div");
		title.className = "subscription-title";
		const name = document.createElement("strong");
		name.textContent = subscription.name;
		const type = document.createElement("span");
		type.className = "list-type";
		type.textContent = subscription.builtIn ? "Built in" : "Custom";
		title.append(name, type);

		const url = document.createElement("p");
		url.className = "subscription-url";
		url.textContent = subscription.url;
		const meta = document.createElement("p");
		meta.className = "subscription-meta";
		meta.textContent = formatLastChecked(cachedLists.get(subscription.id));
		details.append(title, url, meta);

		const actions = document.createElement("div");
		actions.className = "subscription-actions";
		const toggle = document.createElement("input");
		toggle.className = "switch";
		toggle.type = "checkbox";
		toggle.checked = subscription.enabled;
		toggle.disabled = !pageReady;
		toggle.setAttribute("aria-label", `Enable ${subscription.name}`);
		toggle.addEventListener("change", () => {
			void storage.setSubscriptionEnabled(subscription.id, toggle.checked).then(
				async () => {
					await reloadSubscriptions();
					setStatus(`${subscription.name} preference saved.`, "success");
				},
				error => {
					toggle.checked = subscription.enabled;
					setStatus(error instanceof Error ? error.message : "Could not update subscription.", "error");
				}
			);
		});
		actions.append(toggle);

		if (!subscription.builtIn) {
			const remove = document.createElement("button");
			remove.className = "remove-button";
			remove.type = "button";
			remove.textContent = "Remove";
			remove.disabled = !pageReady;
			remove.addEventListener("click", () => {
				void storage.deleteCustomSubscription(subscription.id).then(
					async () => {
						await reloadSubscriptions();
						setStatus(`${subscription.name} was removed.`, "success");
					},
					error => setStatus(error instanceof Error ? error.message : "Could not remove subscription.", "error")
				);
			});
			actions.append(remove);
		}

		top.append(details, actions);
		card.append(top);
		subscriptionList.append(card);
	}
}

async function reloadSubscriptions(): Promise<void> {
	const [nextSubscriptions, records] = await Promise.all([
		storage.getAllSubscriptions(),
		storage.getAll()
	]);
	subscriptions = nextSubscriptions;
	cachedLists = new Map(records.map(record => [record.id, record]));
	renderSubscriptions();
}

networkToggle.addEventListener("change", () => {
	void saveSettings({ networkFilteringEnabled: networkToggle.checked });
});

cosmeticToggle.addEventListener("change", () => {
	void saveSettings({ cosmeticFilteringEnabled: cosmeticToggle.checked });
});

automaticUpdatesToggle.addEventListener("change", () => {
	void saveSettings({ automaticFilterListUpdatesEnabled: automaticUpdatesToggle.checked });
});

intervalSelect.addEventListener("change", () => {
	void saveSettings({ filterListUpdateIntervalMinutes: Number(intervalSelect.value) });
});

themeSelect.addEventListener("change", () => {
	void saveSettings({ theme: themeSelect.value as UserSettings["theme"] });
});

addSubscriptionForm.addEventListener("submit", event => {
	event.preventDefault();
	const rawUrl = subscriptionUrlInput.value.trim();
	const name = subscriptionNameInput.value.trim();

	void (async () => {
		try {
			const url = normalizeCustomFilterListUrl(rawUrl);
			const origin = new URL(url).origin;
			// The host permission prompt is invoked directly from the form submit gesture.
			const granted = await api.permissions.request({ origins: [`${origin}/*`] });
			if (!granted) {
				setStatus("Host permission was not granted; the list was not added.", "error");
				return;
			}

			const added = await storage.addCustomSubscription({ name, url });
			subscriptionNameInput.value = "";
			subscriptionUrlInput.value = "";
			await reloadSubscriptions();
			setStatus(`${added.name} was added to your subscriptions.`, "success");
		} catch (error: unknown) {
			setStatus(error instanceof Error ? error.message : "Could not add filter list.", "error");
		}
	})();
});

refreshButton.addEventListener("click", () => {
	refreshButton.disabled = true;
	setStatus("Checking the supported built-in filter lists…");
	void api.runtime.sendMessage({ type: REFRESH_FILTER_LISTS_MESSAGE }).then(
		response => {
			if (!isRecord(response) || response.ok !== true) {
				const message = isRecord(response) && typeof response.error === "string"
					? response.error
					: "Filter-list refresh failed.";
				throw new Error(message);
			}
			const result = isRecord(response.result) ? response.result : {};
			const report = isRecord(result.download) ? result.download : {};
			const updated = typeof report.updatedCount === "number" ? report.updatedCount : 0;
			const unchanged = typeof report.notModifiedCount === "number" ? report.notModifiedCount : 0;
			const cached = typeof report.cachedCount === "number" ? report.cachedCount : 0;
			setStatus(`Refresh complete · ${updated} updated, ${unchanged} unchanged, ${cached} using cache.`, "success");
			return reloadSubscriptions();
		}
	).catch(error => {
			setStatus(error instanceof Error ? error.message : "Filter-list refresh failed.", "error");
	}).finally(() => {
		refreshButton.disabled = false;
	});
});

resetButton.addEventListener("click", () => {
	void storage.resetUserSettings().then(
		updated => {
			settings = updated;
			renderSettings();
			setStatus("Default preferences restored.", "success");
		},
		error => setStatus(error instanceof Error ? error.message : "Could not restore preferences.", "error")
	);
});

async function initialize(): Promise<void> {
	try {
		const [loadedSettings] = await Promise.all([
			storage.getUserSettings(),
			reloadSubscriptions()
		]);
		settings = loadedSettings;
		pageReady = true;
		for (const control of pageControls) {
			control.disabled = false;
		}
		renderSettings();
		renderSubscriptions();
		setStatus("Settings loaded.");
	} catch (error: unknown) {
		setStatus(error instanceof Error ? error.message : "Could not load settings.", "error");
		for (const control of pageControls) {
			control.disabled = true;
		}
	}
}

void initialize();

export {};
