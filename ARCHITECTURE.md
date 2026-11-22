# Architecture decisions

## ADR-001: Browser-native network filtering

Use `declarativeNetRequest` for network blocking. The Rust engine compiles list
entries into DNR rules before they are installed. This avoids executing Rust,
WASM, or extension callbacks on every request and remains compatible with the
Manifest V3 service-worker lifecycle.

## ADR-002: Rust core, TypeScript adapter

Keep parsing, normalization, matching utilities, and compilation in Rust.
Keep WebExtension APIs, downloads, persistence, UI, and browser-specific
capability detection in TypeScript. The extension adapter is intentionally thin.

## ADR-003: Conservative compilation

Never silently broaden or change a filter's meaning. Unsupported constructs
must produce diagnostics. The compiler must account for exceptions, priority,
resource types, domain restrictions, regex limits, and browser quotas.

## ADR-004: Permission minimization

Network blocking should use the narrowest available DNR permission. Cosmetic
filtering needs page access, so host permissions should be optional and
requested only when the user enables the corresponding feature.
