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

The manifest includes an enabled empty static DNR ruleset as a startup
compatibility workaround for Firefox 128–132, where dynamic rules could fail
to become active after a browser restart. The background runtime also forces
managed dynamic rules to be rebuilt from the verified active filter-list
snapshot on every browser startup, even when downloaded list content is
unchanged. Actual network filtering remains dynamically compiled and managed.

Dynamic DNR quotas are read from the running browser instead of being
hard-coded. Chrome permits up to 30,000 dynamic rules overall, with a separate
5,000-rule ceiling for unsafe actions; Firefox exposes 5,000 dynamic rules and
no separate unsafe-action quota. Regex quotas and optional API features are
also detected at runtime. Missing or invalid quota constants fall back to
conservative cross-browser defaults. If browser-side regex validation is
unavailable, regex filters are skipped with diagnostics while non-regex
filters remain usable. Managed rule IDs are allocated deterministically between
enabled lists using their configured weights.

Do not add remote executable code. Filter-list downloads are data and must be
parsed as untrusted input.
