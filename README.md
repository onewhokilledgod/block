# rust-adblock

A cross-browser ad blocker built around a Rust filter engine and native browser
request filtering.

## Architecture

- **Rust (`filter-engine`)** parses and normalizes filter-list syntax.
- **Rust/WASM (`wasm-bridge`)** will expose the parser/compiler to TypeScript.
- **TypeScript** manages WebExtension APIs, storage, UI, and lifecycle.
- **Declarative Net Request (DNR)** performs network blocking in the browser.
- **Content scripts** apply cosmetic rules (CSS selectors) where host access is
  granted by the user.

The Rust engine is deliberately independent of browser APIs. Network filtering
must not run through a JavaScript callback for every request.

## Workspace

```text
crates/filter-engine   Native parser/model and unit tests
crates/wasm-bridge     WASM exports for the extension
extension              WebExtension UI and browser integration
lists                  Local development filter lists
scripts                Build and maintenance scripts
tests                  End-to-end and browser integration tests
```

## Prerequisites

- Rust stable (the `wasm32-unknown-unknown` target is configured in
  `rust-toolchain.toml`)
- Node.js LTS and a package manager
- Chromium or Firefox for extension testing

## First milestone: parser

```bash
cargo test -p filter-engine
cargo fmt --all -- --check
cargo clippy -p filter-engine --all-targets -- -D warnings
```

The first parser pass handles common network filters, `@@` exceptions,
`$domain`, common resource-type options, `third-party`, `match-case`, and basic
cosmetic filters (`##` / `#@#`). Unknown network options are preserved for the
compiler rather than silently discarded. Procedural cosmetic syntax is
reported as unsupported for now.

## Important limitations

A parsed ABP rule is not automatically a valid DNR rule. DNR has its own URL
pattern syntax, action precedence, regular-expression restrictions, and rule
quotas. The compiler must validate output for each target browser and report
filters it cannot represent faithfully.
