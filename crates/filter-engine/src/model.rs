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

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct NetworkOptions {
	pub domains: Vec<DomainRestriction>,
	pub resource_types: Vec<ResourceType>,
	/// Request types excluded by negated ABP options such as `$~image`.
	pub excluded_resource_types: Vec<ResourceType>,
	/// `Some(true)` means third-party only; `Some(false)` means first-party only.
	pub third_party: Option<bool>,
	pub match_case: bool,
	pub important: bool,
	/// Marks a network filter that disables an equivalent filter in the same list.
	pub badfilter: bool,
	/// ABP sitekeys that scope a filter to signed pages. The current DNR
	/// compiler preserves these as unsupported rather than dropping the scope.
	pub sitekeys: Vec<String>,
	/// Page-level exception modifiers. They are parsed for later page/cosmetic
	/// handling and are not emitted as ordinary network allow rules.
	pub document: bool,
	pub elemhide: bool,
	pub generichide: bool,
	pub genericblock: bool,
	/// Options intentionally preserved for later compiler work.
	pub unsupported: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DomainRestriction {
	pub domain: String,
	pub include: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
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
