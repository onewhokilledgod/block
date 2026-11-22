# Browser extension layer

The extension will target Chromium and Firefox with Manifest V3-compatible
WebExtension APIs. The browser-facing layer is TypeScript; the Rust engine is
compiled to WebAssembly and called only when parsing/compiling filter lists,
not once per network request.

Planned modules:

- `src/background`: filter downloads, compilation orchestration, DNR updates.
- `src/content`: cosmetic filtering and per-page exceptions.
- `src/popup`: quick enable/disable and per-site controls.
- `src/options`: filter subscriptions and advanced settings.
- `src/shared`: browser API adapter and shared types.

Do not add remote executable code. Filter-list downloads are data and must be
parsed as untrusted input.
