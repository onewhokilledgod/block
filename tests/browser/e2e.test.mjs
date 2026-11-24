import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdtempSync,
	rmSync
} from "node:fs";
import { test } from "node:test";
import { build } from "vite";

const require = createRequire(import.meta.url);
const { Builder } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const firefox = require("selenium-webdriver/firefox");

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const browserName = (process.env.BLOCK_E2E_BROWSER ?? "chrome").toLowerCase();

if (browserName !== "chrome" && browserName !== "firefox") {
	throw new Error(
		`Unsupported BLOCK_E2E_BROWSER value: ${browserName}. Use chrome or firefox.`
	);
}

function createPageHtml() {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Block browser E2E</title></head>
<body>
  <div class="e2e-ad" id="cosmetic-ad">Cosmetic test element</div>
  <script>
    window.__blockE2E = {
      started: false,
      blockedExecuted: false,
      blockedError: false,
      allowedExecuted: false,
      imageLoaded: false,
      fetchLoaded: false,
      fetchError: null,
      removeParamLoaded: false,
      removeParamSearch: null
    };

    function startRequests() {
      const state = window.__blockE2E;
      if (state.started || document.documentElement.dataset.blockE2eReady !== "true") {
        return;
      }

      state.started = true;

      const blockedScript = document.createElement("script");
      blockedScript.src = "/ads/blocked.js?e2e=blocked";
      blockedScript.onload = () => { state.blockedExecuted = true; };
      blockedScript.onerror = () => { state.blockedError = true; };
      document.head.append(blockedScript);

      const allowedScript = document.createElement("script");
      allowedScript.src = "/ads/allowed.js?e2e=allowed";
      document.head.append(allowedScript);

      const image = document.createElement("img");
      image.src = "/ads/pixel.svg?e2e=image";
      image.onload = () => { state.imageLoaded = true; };
      document.body.append(image);

      fetch("/ads/ping.json?e2e=fetch", { cache: "no-store" })
        .then(response => {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(() => { state.fetchLoaded = true; })
        .catch(error => { state.fetchError = String(error); });

      fetch("/ads/removeparam.json?e2e_remove=drop&keep=stay", { cache: "no-store" })
        .then(response => {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(data => { state.removeParamSearch = data.search; state.removeParamLoaded = true; })
        .catch(error => { state.removeParamSearch = String(error); state.removeParamLoaded = true; });
    }

    const readyObserver = new MutationObserver(startRequests);
    readyObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-block-e2e-ready"]
    });
    startRequests();
  </script>
</body>
</html>`;
}

async function startTestServer() {
	const requests = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		requests.push({
			pathname: url.pathname,
			search: url.search,
			destination: String(request.headers["sec-fetch-dest"] ?? "")
		});

		response.setHeader("Cache-Control", "no-store");

		if (url.pathname === "/") {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(createPageHtml());
			return;
		}

		if (url.pathname === "/ads/blocked.js") {
			response.writeHead(200, {
				"Content-Type": "application/javascript; charset=utf-8"
			});
			response.end("window.__blockE2E.blockedExecuted = true;");
			return;
		}

		if (url.pathname === "/ads/allowed.js") {
			response.writeHead(200, {
				"Content-Type": "application/javascript; charset=utf-8"
			});
			response.end("window.__blockE2E.allowedExecuted = true;");
			return;
		}

		if (url.pathname === "/ads/pixel.svg") {
			response.writeHead(200, { "Content-Type": "image/svg+xml" });
			response.end(
				'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#000"/></svg>'
			);
			return;
		}

		if (url.pathname === "/ads/ping.json") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ ok: true }));
			return;
		}

		if (url.pathname === "/ads/removeparam.json") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ search: url.search }));
			return;
		}

		if (url.pathname === "/scoped/domain.js") {
			response.writeHead(200, {
				"Content-Type": "application/javascript; charset=utf-8"
			});
			response.end("window.__domainScriptExecuted = true;");
			return;
		}

		response.writeHead(404);
		response.end("Not found");
	});

	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, resolvePromise);
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Could not determine the E2E server port.");
	}

	return {
		server,
		requests,
		port: address.port,
		url: `http://127.0.0.1:${address.port}/`
	};
}

async function prepareTestExtension() {
	const productionDist = join(projectRoot, "extension", "dist");
	for (const requiredFile of [
		"background.js",
		"content.js",
		"rules/startup-compatibility.json"
	]) {
		if (!existsSync(join(productionDist, requiredFile))) {
			throw new Error(
				`Missing ${requiredFile} in extension/dist. Run npm run build first.`
			);
		}
	}

	const extensionDir = mkdtempSync(join(tmpdir(), "block-browser-e2e-"));
	try {
		cpSync(productionDist, extensionDir, { recursive: true });

		// Replace only the background entry point with a deterministic harness.
		// The content.js file remains the actual production content script.
		await build({
			configFile: false,
			root: projectRoot,
			base: "./",
			publicDir: false,
			logLevel: "warn",
			build: {
				outDir: extensionDir,
				emptyOutDir: false,
				target: ["chrome121", "firefox128"],
				assetsInlineLimit: 0,
				rolldownOptions: {
					input: resolve(projectRoot, "tests/browser/background.ts"),
					output: {
						format: "es",
						entryFileNames: "background.js",
						chunkFileNames: "assets/e2e-[name]-[hash].js",
						assetFileNames: "assets/e2e-[name]-[hash][extname]"
					}
				}
			}
		});

		copyFileSync(
			join(projectRoot, "tests", "browser", "manifest.json"),
			join(extensionDir, "manifest.json")
		);
		copyFileSync(
			join(projectRoot, "tests", "browser", "e2e-ready.js"),
			join(extensionDir, "e2e-ready.js")
		);

		return extensionDir;
	} catch (error) {
		rmSync(extensionDir, { recursive: true, force: true });
		throw error;
	}
}

async function createWebDriver() {
	const builder = new Builder().forBrowser(browserName);

	if (browserName === "chrome") {
		const options = new chrome.Options()
			.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
			.enableBidi();
		builder.setChromeOptions(options);
	} else {
		const options = new firefox.Options().addArguments("-headless").enableBidi();
		builder.setFirefoxOptions(options);
	}

	return builder.build();
}

test(
	`real extension behavior in ${browserName}`,
	{ timeout: 120_000 },
	async () => {
		let driver;
		let testServer;
		let extensionDir;

		try {
			testServer = await startTestServer();
			extensionDir = await prepareTestExtension();
			driver = await createWebDriver();

			if (browserName === "firefox") {
				await driver.installWebExtension(extensionDir, { permanent: false });
			} else {
				await driver.installWebExtension(extensionDir);
			}

			await driver.get(testServer.url);

			await driver.wait(
				async () =>
					driver.executeScript(
						"return document.documentElement.dataset.blockE2eReady === 'true' || Boolean(document.documentElement.dataset.blockE2eError);"
					),
				30_000,
				"The extension background did not finish initializing."
			);

			const bootstrapError = await driver.executeScript(
				"return document.documentElement.dataset.blockE2eError || null;"
			);
			assert.equal(bootstrapError, null, `Extension bootstrap failed: ${bootstrapError}`);

			await driver.wait(
				async () =>
					driver.executeScript(`
						const state = window.__blockE2E;
						return Boolean(state && state.started && state.blockedError &&
							state.allowedExecuted && state.imageLoaded && state.fetchLoaded &&
							state.removeParamLoaded);
					`),
				20_000,
				"The expected blocked, allowed, image, and fetch requests did not finish."
			);

			await driver.wait(
				async () =>
					driver.executeScript(`
						const element = document.querySelector('#cosmetic-ad');
						return Boolean(element && getComputedStyle(element).display === 'none');
					`),
				20_000,
				"The production content script did not hide the cosmetic test element."
			);

			const pageState = await driver.executeScript("return window.__blockE2E;");
			assert.equal(pageState.blockedExecuted, false, "The blocking rule did not stop the script.");
			assert.equal(pageState.allowedExecuted, true, "The exception rule did not allow the script.");
			assert.equal(pageState.imageLoaded, true, "The script rule blocked an image resource.");
			assert.equal(pageState.fetchLoaded, true, "The script rule blocked an XHR/fetch resource.");
			assert.equal(
				pageState.removeParamSearch,
				"?keep=stay",
				"The DNR removeparam redirect did not remove the selected query key."
			);

			const countRequests = pathname =>
				testServer.requests.filter(request => request.pathname === pathname).length;
			assert.equal(countRequests("/ads/blocked.js"), 0, "The blocked script reached the test server.");
			assert.equal(countRequests("/ads/allowed.js"), 1, "The allowed script did not reach the test server exactly once.");
			assert.equal(countRequests("/ads/pixel.svg"), 1, "The image request did not reach the test server exactly once.");
			assert.equal(countRequests("/ads/ping.json"), 1, "The fetch request did not reach the test server exactly once.");
			const removeParamRequests = testServer.requests.filter(
				request => request.pathname === "/ads/removeparam.json"
			);
			assert.equal(removeParamRequests.length, 1, "The removeparam request did not reach the server exactly once.");
			assert.equal(removeParamRequests[0].search, "?keep=stay");

			// The domain=localhost rule must block a matching request only when
			// the initiator is localhost, not when the same request comes from
			// the 127.0.0.1 page. The test content script is intentionally not
			// granted access to localhost.
			const domainScriptUrl = `http://127.0.0.1:${testServer.port}/scoped/domain.js`;
			await driver.get(`http://localhost:${testServer.port}/`);
			const unprivilegedPageDisplay = await driver.executeScript(
				"return getComputedStyle(document.querySelector('#cosmetic-ad')).display;"
			);
			assert.equal(
				unprivilegedPageDisplay,
				"block",
				"The extension content script ran without a host permission for localhost."
			);

			const blockedForLocalhost = await driver.executeAsyncScript(
				function (scriptUrl, done) {
					const script = document.createElement("script");
					script.src = scriptUrl;
					script.onload = () => done("loaded");
					script.onerror = () => done("blocked");
					document.head.append(script);
				},
				domainScriptUrl
			);
			assert.equal(blockedForLocalhost, "blocked", "The domain-scoped rule did not block localhost initiators.");

			await driver.get(testServer.url);
			await driver.wait(
				() =>
					driver.executeScript(
						"return document.documentElement.dataset.blockE2eReady === 'true';"
					),
				15_000,
				"The extension did not initialize after navigating back to a permitted host."
			);
			const allowedForIpHost = await driver.executeAsyncScript(
				function (scriptUrl, done) {
					const script = document.createElement("script");
					script.src = scriptUrl;
					script.onload = () => done("loaded");
					script.onerror = () => done("blocked");
					document.head.append(script);
				},
				domainScriptUrl
			);
			assert.equal(allowedForIpHost, "loaded", "The localhost domain rule also blocked a 127.0.0.1 initiator.");
			assert.equal(
				await driver.executeScript("return window.__domainScriptExecuted === true;"),
				true,
				"The domain-scoped script did not execute on 127.0.0.1."
			);
			assert.equal(countRequests("/scoped/domain.js"), 1, "The domain filter did not block exactly the localhost-initiated request.");
		} finally {
			if (driver) {
				await driver.quit().catch(() => undefined);
			}

			if (testServer) {
				await new Promise(resolvePromise => testServer.server.close(resolvePromise));
			}

			if (extensionDir) {
				rmSync(extensionDir, { recursive: true, force: true });
			}
		}
	}
);
