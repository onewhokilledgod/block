const status = document.querySelector<HTMLParagraphElement>("#status");

if (!status) {
	throw new Error("Popup status element was not found.");
}

status.textContent = "Extension loaded. Protection will be configured next.";
export {};
