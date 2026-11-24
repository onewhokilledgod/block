(() => {
	const runtime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime;

	if (!runtime) {
		document.documentElement.dataset.blockE2eError =
			"WebExtension runtime API is unavailable.";
		return;
	}

	void runtime
		.sendMessage({ type: "block-e2e-ready" })
		.then(response => {
			if (!response?.ok) {
				throw new Error(response?.error ?? "E2E background initialization failed.");
			}

			document.documentElement.dataset.blockE2eReady = "true";
		})
		.catch(error => {
			document.documentElement.dataset.blockE2eError = String(error);
		});
})();
