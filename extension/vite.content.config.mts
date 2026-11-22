import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const extensionRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Content scripts are injected as classic scripts by the WebExtension API.
 * Build this entry separately as one self-contained IIFE so it does not rely
 * on module imports or shared chunks at injection time.
 */
export default defineConfig({
	root: extensionRoot,
	base: "./",

	build: {
		outDir: resolve(extensionRoot, "dist"),
		emptyOutDir: false,
		target: ["chrome121", "firefox128"],

		lib: {
			entry: resolve(extensionRoot, "src/content/index.ts"),
			name: "BlockContent",
			formats: ["iife"],
			fileName: () => "content.js"
		}
	}
});
