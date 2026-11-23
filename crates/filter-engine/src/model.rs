//! Browser-independent representation of parsed filter-list entries.

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Filter {
	Network(NetworkFilter),
	Cosmetic(CosmeticFilter),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkFilter {
	/// Original ABP-style URL pattern, without the exception prefix/options.
	pub pattern: String,
	/// `true` for `@@` exception filters.
	pub exception: bool,
	pub options: NetworkOptions,
	/// One-based line number in the original input.
	pub source_line: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NetworkOptions {
	pub domains: Vec<DomainRestriction>,
	pub resource_types: Vec<ResourceType>,
	/// Request types excluded by negated ABP options such as `$~image`.
	pub excluded_resource_types: Vec<ResourceType>,
	/// `Some(true)` means third-party only; `Some(false)` means first-party only.
	pub third_party: Option<bool>,
	pub match_case: bool,
	pub important: bool,
	/// Options intentionally preserved for later compiler work.
	pub unsupported: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainRestriction {
	pub domain: String,
	pub include: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ResourceType {
	MainFrame,
	SubFrame,
	Stylesheet,
	Script,
	Image,
	Font,
	Object,
	XmlHttpRequest,
	Ping,
	Media,
	WebSocket,
	Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CosmeticFilter {
	/// Empty means a generic cosmetic rule applying to all sites.
	pub domains: Vec<DomainRestriction>,
	pub selector: String,
	/// `true` for `#@#` cosmetic exceptions.
	pub exception: bool,
	pub source_line: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
	pub line: usize,
	pub level: DiagnosticLevel,
	pub message: String,
	pub source: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagnosticLevel {
	Warning,
	Error,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedFilterList {
	pub filters: Vec<Filter>,
	pub diagnostics: Vec<Diagnostic>,
}
