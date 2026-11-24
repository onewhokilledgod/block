# Real browser integration tests

These tests install a temporary test build of the extension in a real Chromium
or Firefox session through Selenium WebDriver BiDi. They exercise the compiled
Rust/WASM filter engine, the production DNR rules manager, and the production
cosmetic content script. The local HTTP server makes the test independent of
external filter-list availability.

The test build is assembled in the operating system's temporary directory.
It reuses the production `content.js`, but replaces the background entry point
with a deterministic harness that installs a small local ABP fixture. The
release manifest and release background bundle are not modified.

## Run locally

Update the lockfile for the added Selenium dependency, install the dependencies,
and build the extension first:

```bash
npm install --package-lock-only --ignore-scripts
npm ci
cargo install wasm-pack --locked --version 0.15.1
npm run build
```

Run the Chromium test (default):

```bash
npm run test:browser
```

Run Firefox instead:

```bash
BLOCK_E2E_BROWSER=firefox npm run test:browser
```

Selenium 4.54.0 requires Node.js 22.23.4, 24.22.1, or 26.12.1 and newer.
Selenium Manager resolves the matching WebDriver binary. CI runs the same
suite in separate Chrome and Firefox jobs.
