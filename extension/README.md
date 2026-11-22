# Browser extension layer

The extension targets Chromium and Firefox with Manifest V3-compatible
WebExtension APIs. The browser-facing layer is TypeScript; the Rust engine is
compiled to WebAssembly and called when parsing/compiling filter lists, not
once per network request.

Current modules:

- `src/background`: filter downloads, compilation orchestration, DNR updates,
  and the cosmetic-content messaging bridge.
- `src/content`: page-side cosmetic selector validation and message dispatch.
- `src/popup`: requests optional access for the current site and enables its
  registered cosmetic content script.
- `src/shared`: filter-engine bindings and message contracts.

Cosmetic filtering is opt-in per site. The extension requests host access only
when the user activates it from the popup. The registered content script asks
the background worker for matching selectors; the worker applies generated CSS
through the browser scripting API, keeping styles independent of page CSP.

Do not add remote executable code. Filter-list downloads are data and must be
parsed as untrusted input.
