import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const extensionRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	root: extensionRoot,

	// Расширение запускается с собственного URL,
	// поэтому используем относительные пути.
	base: "./",

	publicDir: resolve(extensionRoot, "public"),

	build: {
		outDir: resolve(extensionRoot, "dist"),
		emptyOutDir: true,

		target: ["chrome121", "firefox121"],

		// Не встраиваем WASM в JS через base64.
		assetsInlineLimit: 0,

		rolldownOptions: {
			input: {
				background: resolve(extensionRoot, "src/background/index.ts"),

				popup: resolve(extensionRoot, "popup.html")
			},

			output: {
				entryFileNames: chunk => {
					if (chunk.name === "background") {
						return "background.js";
					}

					return "assets/[name]-[hash].js";
				},

				chunkFileNames: "assets/chunks/[name]-[hash].js",

				assetFileNames: "assets/[name]-[hash][extname]"
			}
		}
	}
});
