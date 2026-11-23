//! Conservative compiler from the parsed ABP subset to browser DNR rules.
//!
//! The compiler deliberately rejects rules whose meaning cannot be represented
//! faithfully. It never drops an unknown option and then emits a broader rule.

use std::collections::HashSet;

use serde::Serialize;

use crate::model::{
	DomainRestriction, Filter, NetworkFilter, ParsedFilterList, ResourceType,
};

/// A regular blocking rule is the baseline.
///
/// ABP exception rules must beat normal blocking rules, while `$important`
/// blocking rules must beat exceptions. Using distinct priorities makes that
/// relationship explicit and avoids relying on action tie-breakers.
pub const PRIORITY_NORMAL_BLOCK: u32 = 100;
pub const PRIORITY_EXCEPTION: u32 = 200;
pub const PRIORITY_IMPORTANT_BLOCK: u32 = 300;
const MAX_DNR_RULE_ID: u32 = i32::MAX as u32;

/// Limits for one DNR ruleset. These are configurable because browser limits
/// differ and can change between browser versions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DnrLimits {
	pub max_rules: usize,
	pub max_regex_rules: usize,
}

impl DnrLimits {
	/// Lowest common dynamic-rule ceiling for current Chrome and Firefox.
	pub const fn cross_browser() -> Self {
		Self {
			max_rules: 5_000,
			max_regex_rules: 1_000,
		}
	}

	/// Current Chrome dynamic-rule ceiling for safe `block`/`allow` rules.
	pub const fn chrome_dynamic() -> Self {
		Self {
			max_rules: 30_000,
			max_regex_rules: 1_000,
		}
	}

	/// Current Firefox dynamic-rule ceiling.
	pub const fn firefox_dynamic() -> Self {
		Self {
			max_rules: 5_000,
			max_regex_rules: 1_000,
		}
	}
}

impl Default for DnrLimits {
	fn default() -> Self {
		Self::cross_browser()
	}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompileOptions {
	pub limits: DnrLimits,
	/// First rule ID in the output ruleset. DNR IDs must be positive.
	pub first_rule_id: u32,
}

impl Default for CompileOptions {
	fn default() -> Self {
		Self {
			limits: DnrLimits::default(),
			first_rule_id: 1,
		}
	}
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnrRule {
	pub id: u32,
	pub priority: u32,
	pub action: DnrAction,
	pub condition: DnrCondition,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DnrAction {
	#[serde(rename = "type")]
	pub action_type: DnrActionType,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DnrActionType {
	Block,
	Allow,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnrCondition {
	#[serde(skip_serializing_if = "Option::is_none")]
	pub url_filter: Option<String>,

	#[serde(skip_serializing_if = "Option::is_none")]
	pub regex_filter: Option<String>,

	#[serde(skip_serializing_if = "Option::is_none")]
	pub is_url_filter_case_sensitive: Option<bool>,

	#[serde(skip_serializing_if = "Option::is_none")]
	pub initiator_domains: Option<Vec<String>>,

	#[serde(skip_serializing_if = "Option::is_none")]
	pub excluded_initiator_domains: Option<Vec<String>>,

	#[serde(skip_serializing_if = "Option::is_none")]
	pub domain_type: Option<DnrDomainType>,

	pub resource_types: Vec<DnrResourceType>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DnrDomainType {
	FirstParty,
	ThirdParty,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum DnrResourceType {
	#[serde(rename = "main_frame")]
	MainFrame,
	#[serde(rename = "sub_frame")]
	SubFrame,
	#[serde(rename = "stylesheet")]
	Stylesheet,
	#[serde(rename = "script")]
	Script,
	#[serde(rename = "image")]
	Image,
	#[serde(rename = "font")]
	Font,
	#[serde(rename = "object")]
	Object,
	#[serde(rename = "xmlhttprequest")]
	XmlHttpRequest,
	#[serde(rename = "ping")]
	Ping,
	#[serde(rename = "csp_report")]
	CspReport,
	#[serde(rename = "media")]
	Media,
	#[serde(rename = "websocket")]
	WebSocket,
	#[serde(rename = "other")]
	Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompileDiagnosticLevel {
	Warning,
	Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompileDiagnosticCode {
	UnsupportedOption,
	UnsupportedUrlPattern,
	UnsupportedRegex,
	UnsupportedDomain,
	UnsupportedImportantException,
	InvalidFirstRuleId,
	RuleLimitExceeded,
	RegexRuleLimitExceeded,
	RuleIdExhausted,
}
/// Shared error type for a filter that cannot be represented faithfully in DNR.
type CompileError = (CompileDiagnosticCode, String);

/// Included and excluded initiator domains produced from an ABP `$domain` option.
type CompiledDomains = (Option<Vec<String>>, Option<Vec<String>>);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileDiagnostic {
	pub line: usize,
	pub level: CompileDiagnosticLevel,
	pub code: CompileDiagnosticCode,
	pub message: String,
	pub pattern: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileStats {
	pub network_filters_seen: usize,
	pub compiled_rules: usize,
	pub skipped_network_filters: usize,
	pub cosmetic_filters_deferred: usize,
	pub regex_rules: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileReport {
	pub rules: Vec<DnrRule>,
	pub diagnostics: Vec<CompileDiagnostic>,
	pub stats: CompileStats,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct BadfilterKey {
	pattern: String,
	exception: bool,
	options: crate::model::NetworkOptions,
}

/// Builds a semantic key while ignoring the `$badfilter` marker itself.
/// Option collections are sets in ABP semantics, so their input order does not
/// affect whether two network filters refer to the same rule.
fn badfilter_key(filter: &NetworkFilter) -> BadfilterKey {
	let mut options = filter.options.clone();
	options.badfilter = false;
	options.domains.sort_unstable();
	options.domains.dedup();
	options.resource_types.sort_unstable();
	options.resource_types.dedup();
	options.excluded_resource_types.sort_unstable();
	options.excluded_resource_types.dedup();
	options.sitekeys.sort_unstable();
	options.sitekeys.dedup();
	options.unsupported.sort_unstable();
	options.unsupported.dedup();

	BadfilterKey {
		pattern: filter.pattern.clone(),
		exception: filter.exception,
		options,
	}
}

/// Compile the network filters in a parsed list into DNR rules.
///
/// Cosmetic rules are deliberately counted but not emitted here; they will be
/// handled by the cosmetic engine. Unsupported network rules are skipped with
/// diagnostics so callers can show exactly what was not compiled.
pub fn compile_filter_list(
	parsed: &ParsedFilterList,
	options: CompileOptions,
) -> CompileReport {
	let badfilter_keys = collect_badfilter_keys(std::iter::once(parsed));
	compile_filter_list_with_badfilter_keys(parsed, options, &badfilter_keys)
}

/// Compile multiple lists as one semantic group while preserving one report
/// and one independent rule-ID range for each input list.
///
/// `$badfilter` markers in any input list disable equivalent network filters
/// in every other input list, regardless of input order.
pub fn compile_filter_lists(
	inputs: &[(&ParsedFilterList, CompileOptions)],
) -> Vec<CompileReport> {
	let badfilter_keys =
		collect_badfilter_keys(inputs.iter().map(|(parsed, _)| *parsed));

	inputs
		.iter()
		.map(|(parsed, options)| {
			compile_filter_list_with_badfilter_keys(parsed, *options, &badfilter_keys)
		})
		.collect()
}

fn collect_badfilter_keys<'a>(
	parsed_lists: impl IntoIterator<Item = &'a ParsedFilterList>,
) -> HashSet<BadfilterKey> {
	parsed_lists
		.into_iter()
		.flat_map(|parsed| parsed.filters.iter())
		.filter_map(|filter| match filter {
			Filter::Network(network_filter) if network_filter.options.badfilter => {
				Some(badfilter_key(network_filter))
			}
			_ => None,
		})
		.collect()
}

fn compile_filter_list_with_badfilter_keys(
	parsed: &ParsedFilterList,
	options: CompileOptions,
	badfilter_keys: &HashSet<BadfilterKey>,
) -> CompileReport {
	let mut report = CompileReport::default();

	if options.first_rule_id == 0 || options.first_rule_id > MAX_DNR_RULE_ID {
		report.diagnostics.push(CompileDiagnostic {
			line: 0,
			level: CompileDiagnosticLevel::Error,
			code: CompileDiagnosticCode::InvalidFirstRuleId,
			message: format!(
				"The first DNR rule ID must be in the range 1..={MAX_DNR_RULE_ID}"
			),
			pattern: String::new(),
		});
		report.stats.skipped_network_filters = parsed
			.filters
			.iter()
			.filter(|filter| matches!(filter, Filter::Network(_)))
			.count();
		report.stats.network_filters_seen = report.stats.skipped_network_filters;
		report.stats.cosmetic_filters_deferred = parsed
			.filters
			.iter()
			.filter(|filter| matches!(filter, Filter::Cosmetic(_)))
			.count();
		return report;
	}

	let mut next_rule_id = Some(options.first_rule_id);
	let mut limit_diagnostic_emitted = false;
	let mut id_diagnostic_emitted = false;
	let mut regex_limit_diagnostic_emitted = false;

	for filter in &parsed.filters {
		let Filter::Network(network_filter) = filter else {
			report.stats.cosmetic_filters_deferred += 1;
			continue;
		};

		report.stats.network_filters_seen += 1;
		if network_filter.options.badfilter
			|| (!badfilter_keys.is_empty()
				&& badfilter_keys.contains(&badfilter_key(network_filter)))
		{
			report.stats.skipped_network_filters += 1;
			continue;
		}

		if requires_browser_regex_filter(&network_filter.pattern)
			&& report.stats.regex_rules >= options.limits.max_regex_rules
		{
			report.stats.skipped_network_filters += 1;
			if !regex_limit_diagnostic_emitted {
				report.diagnostics.push(CompileDiagnostic {
					line: network_filter.source_line,
					level: CompileDiagnosticLevel::Warning,
					code: CompileDiagnosticCode::RegexRuleLimitExceeded,
					message: format!(
						"The configured DNR regex rule limit ({}) has been reached; remaining regex filters were skipped",
						options.limits.max_regex_rules
					),
					pattern: network_filter.pattern.clone(),
				});
				regex_limit_diagnostic_emitted = true;
			}
			continue;
		}

		if report.rules.len() >= options.limits.max_rules {
			report.stats.skipped_network_filters += 1;
			if !limit_diagnostic_emitted {
				report.diagnostics.push(CompileDiagnostic {
                    line: network_filter.source_line,
                    level: CompileDiagnosticLevel::Warning,
                    code: CompileDiagnosticCode::RuleLimitExceeded,
                    message: format!(
                        "The configured DNR ruleset limit ({}) has been reached; remaining network filters were skipped",
                        options.limits.max_rules
                    ),
                    pattern: network_filter.pattern.clone(),
                });
				limit_diagnostic_emitted = true;
			}
			continue;
		}

		let Some(rule_id) = next_rule_id else {
			report.stats.skipped_network_filters += 1;
			if !id_diagnostic_emitted {
				report.diagnostics.push(CompileDiagnostic {
					line: network_filter.source_line,
					level: CompileDiagnosticLevel::Error,
					code: CompileDiagnosticCode::RuleIdExhausted,
					message: "No further positive DNR rule IDs are available".into(),
					pattern: network_filter.pattern.clone(),
				});
				id_diagnostic_emitted = true;
			}
			continue;
		};

		match compile_network_filter(network_filter, rule_id) {
			Ok(rule) => {
				if rule.condition.regex_filter.is_some() {
					report.stats.regex_rules += 1;
				}
				report.rules.push(rule);
				report.stats.compiled_rules += 1;
				next_rule_id = (rule_id < MAX_DNR_RULE_ID).then_some(rule_id + 1);
			}
			Err((code, message)) => {
				report.stats.skipped_network_filters += 1;
				report.diagnostics.push(CompileDiagnostic {
					line: network_filter.source_line,
					level: CompileDiagnosticLevel::Warning,
					code,
					message,
					pattern: network_filter.pattern.clone(),
				});
			}
		}
	}

	report
}

fn compile_network_filter(
	filter: &NetworkFilter,
	rule_id: u32,
) -> Result<DnrRule, CompileError> {
	if !filter.options.sitekeys.is_empty() {
		return Err((
			CompileDiagnosticCode::UnsupportedOption,
			"This filter uses $sitekey, which the DNR compiler cannot enforce".into(),
		));
	}
	if !filter.options.unsupported.is_empty() {
		return Err((
			CompileDiagnosticCode::UnsupportedOption,
			format!(
				"This filter uses options that are not supported by the DNR compiler: {}",
				filter.options.unsupported.join(", ")
			),
		));
	}

	if filter.exception && filter.options.important {
		return Err((
            CompileDiagnosticCode::UnsupportedImportantException,
            "The $important modifier on an exception filter has ambiguous precedence and is not compiled".into(),
        ));
	}

	let (url_filter, regex_filter) = if filter.pattern.is_empty() {
		(None, None)
	} else if is_abp_regex_filter(&filter.pattern) {
		let expression = &filter.pattern[1..filter.pattern.len() - 1];
		if expression.is_empty() || !expression.is_ascii() {
			return Err((
				CompileDiagnosticCode::UnsupportedRegex,
				"ABP regular expressions must be non-empty and contain only ASCII characters".into(),
			));
		}
		(None, Some(expression.to_owned()))
	} else if filter.pattern.contains('\\') {
		let expression = compile_abp_url_pattern_regex(&filter.pattern)?;
		(None, Some(expression))
	} else {
		validate_url_filter(&filter.pattern)?;
		(Some(filter.pattern.clone()), None)
	};

	let is_url_filter_case_sensitive = if (url_filter.is_some()
		|| regex_filter.is_some())
		&& filter.options.match_case
	{
		Some(true)
	} else {
		None
	};
	let (initiator_domains, excluded_initiator_domains) =
		compile_domains(&filter.options.domains)?;

	let mut resource_types = if filter.options.resource_types.is_empty() {
		all_dnr_resource_types()
	} else {
		let mut result = Vec::new();
		for resource_type in &filter.options.resource_types {
			let mapped = map_resource_type(*resource_type);
			if !result.contains(&mapped) {
				result.push(mapped);
			}
		}
		result
	};
	for resource_type in &filter.options.excluded_resource_types {
		let excluded = map_resource_type(*resource_type);
		resource_types.retain(|included| *included != excluded);
	}

	if resource_types.is_empty() {
		return Err((
			CompileDiagnosticCode::UnsupportedOption,
			"Resource-type exclusions remove every included DNR request type".into(),
		));
	}

	let priority = if filter.exception {
		PRIORITY_EXCEPTION
	} else if filter.options.important {
		PRIORITY_IMPORTANT_BLOCK
	} else {
		PRIORITY_NORMAL_BLOCK
	};

	let action_type = if filter.exception {
		DnrActionType::Allow
	} else {
		DnrActionType::Block
	};

	Ok(DnrRule {
		id: rule_id,
		priority,
		action: DnrAction { action_type },
		condition: DnrCondition {
			url_filter,
			regex_filter,
			is_url_filter_case_sensitive,
			initiator_domains,
			excluded_initiator_domains,
			domain_type: filter.options.third_party.map(|third_party| {
				if third_party {
					DnrDomainType::ThirdParty
				} else {
					DnrDomainType::FirstParty
				}
			}),
			resource_types,
		},
	})
}

fn validate_url_filter(pattern: &str) -> Result<(), CompileError> {
	if pattern.is_empty() {
		return Err((
			CompileDiagnosticCode::UnsupportedUrlPattern,
			"The URL pattern is empty".into(),
		));
	}

	if pattern.starts_with('/') && pattern.ends_with('/') && pattern.len() >= 2 {
		return Err((
            CompileDiagnosticCode::UnsupportedUrlPattern,
            "ABP regular-expression filters are deferred until browser-side RE2 validation is implemented".into(),
        ));
	}

	if pattern.contains('\\') {
		return Err((
            CompileDiagnosticCode::UnsupportedUrlPattern,
            "Escaped URL-pattern syntax is not compiled yet because its ABP and DNR meanings must be normalized first".into(),
        ));
	}

	Ok(())
}

fn is_abp_regex_filter(pattern: &str) -> bool {
	pattern.len() >= 2 && pattern.starts_with('/') && pattern.ends_with('/')
}

fn requires_browser_regex_filter(pattern: &str) -> bool {
	is_abp_regex_filter(pattern) || pattern.contains('\\')
}

/// Converts an ASCII ABP simple URL pattern containing a literal backslash
/// into an equivalent RE2 expression. This avoids relying on undocumented
/// backslash handling in DNR's urlFilter grammar.
fn compile_abp_url_pattern_regex(
	pattern: &str,
) -> Result<String, CompileError> {
	if !pattern.is_ascii() {
		return Err((
			CompileDiagnosticCode::UnsupportedRegex,
			"ABP URL patterns containing backslashes must be ASCII before conversion to DNR regex".into(),
		));
	}

	// ABP treats repeated wildcards as one and ignores leading/trailing `*`.
	let mut normalized = String::with_capacity(pattern.len());
	let mut previous_wildcard = false;
	for character in pattern.chars() {
		if character == '*' {
			if !previous_wildcard {
				normalized.push(character);
			}
			previous_wildcard = true;
		} else {
			normalized.push(character);
			previous_wildcard = false;
		}
	}
	if normalized.starts_with('*') {
		normalized.remove(0);
	}
	if normalized.ends_with('*') {
		normalized.pop();
	}

	// In ABP, a trailing `^|` is equivalent to a trailing separator.
	if normalized.ends_with("^|") {
		normalized.pop();
	}

	let mut remaining = normalized.as_str();
	let mut expression = String::new();
	if let Some(rest) = remaining.strip_prefix("||") {
		expression.push_str(r"^[\w-]+://(?:[^/]+\.)?");
		remaining = rest;
	} else if let Some(rest) = remaining.strip_prefix('|') {
		expression.push('^');
		remaining = rest;
	}

	let ends_with_separator = remaining.ends_with('^');
	let ends_with_anchor = !ends_with_separator && remaining.ends_with('|');
	if ends_with_separator || ends_with_anchor {
		remaining = &remaining[..remaining.len() - 1];
	}

	for character in remaining.chars() {
		match character {
			'*' => expression.push_str(".*"),
			'^' => expression.push_str(
				r"(?:[\x00-\x24\x26-\x2C\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7F]|$)",
			),
			'\\' | '.' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
			| '$' => {
				expression.push('\\');
				expression.push(character);
			}
			_ => expression.push(character),
		}
	}

	if ends_with_separator {
		expression.push_str(
			r"(?:[\x00-\x24\x26-\x2C\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7F]|$)",
		);
	} else if ends_with_anchor {
		expression.push('$');
	}

	Ok(expression)
}

fn compile_domains(
	domains: &[DomainRestriction],
) -> Result<CompiledDomains, CompileError> {
	let mut included = Vec::new();
	let mut excluded = Vec::new();

	for restriction in domains {
		// Normalize like browser URL hosts, then enforce the DNR hostname subset.
		let normalized_domain = idna::domain_to_ascii(&restriction.domain)
			.ok()
			.filter(|domain| is_dnr_domain(domain))
			.ok_or_else(|| {
				(
					CompileDiagnosticCode::UnsupportedDomain,
					format!(
						"Domain '{}' cannot be normalized to a valid ASCII DNR hostname",
						restriction.domain
					),
				)
			})?;

		let target = if restriction.include {
			&mut included
		} else {
			&mut excluded
		};

		if !target.contains(&normalized_domain) {
			target.push(normalized_domain);
		}
	}

	Ok((
		(!included.is_empty()).then_some(included),
		(!excluded.is_empty()).then_some(excluded),
	))
}

fn is_dnr_domain(domain: &str) -> bool {
	if domain.is_empty()
		|| domain.len() > 253
		|| !domain.is_ascii()
		|| domain.starts_with('.')
		|| domain.ends_with('.')
	{
		return false;
	}

	domain.split('.').all(|label| {
		!label.is_empty()
			&& label.len() <= 63
			&& !label.starts_with('-')
			&& !label.ends_with('-')
			&& label
				.bytes()
				.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
	})
}

fn map_resource_type(resource_type: ResourceType) -> DnrResourceType {
	match resource_type {
		ResourceType::MainFrame => DnrResourceType::MainFrame,
		ResourceType::SubFrame => DnrResourceType::SubFrame,
		ResourceType::Stylesheet => DnrResourceType::Stylesheet,
		ResourceType::Script => DnrResourceType::Script,
		ResourceType::Image => DnrResourceType::Image,
		ResourceType::Font => DnrResourceType::Font,
		ResourceType::Object => DnrResourceType::Object,
		ResourceType::XmlHttpRequest => DnrResourceType::XmlHttpRequest,
		ResourceType::Ping => DnrResourceType::Ping,
		ResourceType::Media => DnrResourceType::Media,
		ResourceType::WebSocket => DnrResourceType::WebSocket,
		ResourceType::Other => DnrResourceType::Other,
	}
}

/// Explicit baseline used for unqualified filters and filters with only
/// negated resource-type options. This includes `main_frame`, which DNR omits
/// from its implicit resource-type set.
fn all_dnr_resource_types() -> Vec<DnrResourceType> {
	vec![
		DnrResourceType::MainFrame,
		DnrResourceType::SubFrame,
		DnrResourceType::Stylesheet,
		DnrResourceType::Script,
		DnrResourceType::Image,
		DnrResourceType::Font,
		DnrResourceType::Object,
		DnrResourceType::XmlHttpRequest,
		DnrResourceType::Ping,
		DnrResourceType::CspReport,
		DnrResourceType::Media,
		DnrResourceType::WebSocket,
		DnrResourceType::Other,
	]
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::parse_filter_list;

	fn compile(input: &str) -> CompileReport {
		let parsed = parse_filter_list(input);
		compile_filter_list(&parsed, CompileOptions::default())
	}

	#[test]
	fn page_scope_exceptions_are_not_emitted_as_broad_network_allow_rules() {
		for modifier in ["document", "elemhide", "generichide", "genericblock"] {
			let report = compile(&format!("@@||example.com^${modifier}"));

			assert!(report.rules.is_empty(), "modifier: {modifier}");
			assert_eq!(report.stats.skipped_network_filters, 1);
			assert_eq!(
				report.diagnostics[0].code,
				CompileDiagnosticCode::UnsupportedOption,
				"modifier: {modifier}"
			);
		}
	}

	#[test]
	fn badfilter_matches_sitekey_lists_independent_of_option_order() {
		let report = compile(
			"||ads.example^$script,sitekey=firstKey|secondKey\n\
			||ads.example^$sitekey=secondKey|firstKey,script,badfilter\n\
			||keep.example^",
		);

		assert_eq!(report.rules.len(), 1);
		assert_eq!(
			report.rules[0].condition.url_filter.as_deref(),
			Some("||keep.example^")
		);
		assert_eq!(report.stats.skipped_network_filters, 2);
	}

	#[test]
	fn sitekey_scoped_rules_are_not_compiled_without_sitekey_matching() {
		let report = compile("||ads.example^$sitekey=firstKey|secondKey");

		assert!(report.rules.is_empty());
		assert_eq!(report.stats.skipped_network_filters, 1);
		assert_eq!(
			report.diagnostics[0].code,
			CompileDiagnosticCode::UnsupportedOption
		);
	}

	#[test]
	fn compiles_basic_block_rule_to_dnr() {
		let report = compile("||ads.example^");
		assert_eq!(report.rules.len(), 1);

		let rule = &report.rules[0];
		assert_eq!(rule.id, 1);
		assert_eq!(rule.priority, PRIORITY_NORMAL_BLOCK);
		assert_eq!(rule.action.action_type, DnrActionType::Block);
		assert_eq!(rule.condition.url_filter, Some("||ads.example^".to_owned()));
		assert!(
			rule
				.condition
				.resource_types
				.contains(&DnrResourceType::MainFrame)
		);
		assert_eq!(report.stats.compiled_rules, 1);
		assert!(report.diagnostics.is_empty());
	}

	#[test]
	fn exception_beats_normal_block_and_important_block_beats_exception() {
		let report = compile(
			"||ads.example^\n@@||ads.example^$script\n||critical.example^$important",
		);

		assert_eq!(report.rules.len(), 3);
		assert_eq!(report.rules[0].priority, PRIORITY_NORMAL_BLOCK);
		assert_eq!(report.rules[0].action.action_type, DnrActionType::Block);
		assert_eq!(report.rules[1].priority, PRIORITY_EXCEPTION);
		assert_eq!(report.rules[1].action.action_type, DnrActionType::Allow);
		assert_eq!(report.rules[2].priority, PRIORITY_IMPORTANT_BLOCK);
		assert_eq!(report.rules[2].action.action_type, DnrActionType::Block);
	}

	#[test]
	fn compiles_domain_and_party_conditions() {
		let report = compile(
			"||tracker.example^$script,third-party,domain=example.com|~news.example",
		);
		let condition = &report.rules[0].condition;

		assert_eq!(
			condition
				.initiator_domains
				.as_ref()
				.expect("included domains"),
			&vec!["example.com".to_owned()]
		);
		assert_eq!(
			condition
				.excluded_initiator_domains
				.as_ref()
				.expect("excluded domains"),
			&vec!["news.example".to_owned()]
		);
		assert_eq!(condition.domain_type, Some(DnrDomainType::ThirdParty));
		assert_eq!(condition.resource_types, vec![DnrResourceType::Script]);
	}

	#[test]
	fn compiles_negated_resource_type_options_as_an_explicit_complement() {
		let report = compile("||ads.example^$~image,~script");
		let resource_types = &report.rules[0].condition.resource_types;

		assert_eq!(resource_types.len(), 11);
		assert!(resource_types.contains(&DnrResourceType::MainFrame));
		assert!(resource_types.contains(&DnrResourceType::CspReport));
		assert!(!resource_types.contains(&DnrResourceType::Image));
		assert!(!resource_types.contains(&DnrResourceType::Script));
		assert!(report.diagnostics.is_empty());
	}

	#[test]
	fn applies_resource_type_exclusions_after_inclusions() {
		let report = compile("||ads.example^$script,image,~image");

		assert_eq!(
			report.rules[0].condition.resource_types,
			vec![DnrResourceType::Script]
		);
	}

	#[test]
	fn skips_rules_with_no_resource_types_after_exclusion() {
		let report = compile("||ads.example^$script,~script");

		assert!(report.rules.is_empty());
		assert_eq!(report.stats.skipped_network_filters, 1);
		assert_eq!(
			report.diagnostics[0].code,
			CompileDiagnosticCode::UnsupportedOption
		);
	}

	#[test]
	fn badfilter_disables_equivalent_network_rule_independent_of_option_order() {
		let report = compile(
			"||ads.example^$script,third-party,domain=example.com|~news.example\n\
         ||ads.example^$badfilter,domain=example.com|~news.example,third-party,script\n\
         ||keep.example^",
		);

		assert_eq!(report.rules.len(), 1);
		assert_eq!(
			report.rules[0].condition.url_filter.as_deref(),
			Some("||keep.example^")
		);
		assert_eq!(report.stats.network_filters_seen, 3);
		assert_eq!(report.stats.skipped_network_filters, 2);
		assert!(report.diagnostics.is_empty());
	}

	#[test]
	fn badfilter_does_not_disable_an_exception_with_the_same_pattern() {
		let report =
			compile("@@||ads.example^\n||ads.example^$badfilter\n||keep.example^");

		assert_eq!(report.rules.len(), 2);
		assert_eq!(report.rules[0].action.action_type, DnrActionType::Allow);
		assert_eq!(
			report.rules[0].condition.url_filter.as_deref(),
			Some("||ads.example^")
		);
		assert_eq!(
			report.rules[1].condition.url_filter.as_deref(),
			Some("||keep.example^")
		);
		assert_eq!(report.stats.skipped_network_filters, 1);
	}

	#[test]
	fn badfilter_disables_matching_rules_across_lists_even_when_marker_is_later()
	{
		let easylist = parse_filter_list("||shared.example^");
		let easyprivacy =
			parse_filter_list("||shared.example^$badfilter\n||privacy.example^");
		let reports = compile_filter_lists(&[
			(&easylist, CompileOptions::default()),
			(
				&easyprivacy,
				CompileOptions {
					first_rule_id: 3501,
					..CompileOptions::default()
				},
			),
		]);

		assert!(reports[0].rules.is_empty());
		assert_eq!(reports[0].stats.skipped_network_filters, 1);
		assert_eq!(reports[1].rules.len(), 1);
		assert_eq!(reports[1].rules[0].id, 3501);
		assert_eq!(reports[1].stats.skipped_network_filters, 1);
	}

	#[test]
	fn badfilter_from_first_list_disables_equivalent_rule_in_later_list() {
		let easylist = parse_filter_list("||shared.example^$badfilter");
		let easyprivacy = parse_filter_list("||shared.example^");
		let reports = compile_filter_lists(&[
			(&easylist, CompileOptions::default()),
			(
				&easyprivacy,
				CompileOptions {
					first_rule_id: 3501,
					..CompileOptions::default()
				},
			),
		]);

		assert!(reports[0].rules.is_empty());
		assert!(reports[1].rules.is_empty());
		assert_eq!(reports[0].stats.skipped_network_filters, 1);
		assert_eq!(reports[1].stats.skipped_network_filters, 1);
	}

	#[test]
	fn negative_only_domains_compile_as_exclusions() {
		let report =
			compile("||tracker.example^$domain=~trusted.example|~news.example");
		let condition = &report.rules[0].condition;

		assert_eq!(condition.initiator_domains, None);
		assert_eq!(
			condition
				.excluded_initiator_domains
				.as_ref()
				.expect("excluded domains"),
			&vec!["trusted.example".to_owned(), "news.example".to_owned()]
		);
	}

	#[test]
	fn match_case_is_emitted_only_when_requested() {
		let report = compile("||CaseSensitive.example^$match-case");
		assert_eq!(
			report.rules[0].condition.is_url_filter_case_sensitive,
			Some(true)
		);
	}

	#[test]
	fn serializes_browser_field_names_and_omits_absent_options() {
		let report = compile("||ads.example^$script,third-party");
		let json = serde_json::to_value(&report.rules[0]).expect("rule serializes");

		assert_eq!(json["action"]["type"], "block");
		assert_eq!(json["condition"]["urlFilter"], "||ads.example^");
		assert_eq!(json["condition"]["resourceTypes"][0], "script");
		assert_eq!(json["condition"]["domainType"], "thirdParty");
		assert!(json["condition"].get("initiatorDomains").is_none());
		assert!(json["condition"].get("isUrlFilterCaseSensitive").is_none());
	}

	#[test]
	fn unsupported_options_skip_the_entire_rule() {
		let report =
			compile("||ads.example^$script,redirect=noopjs\n||good.example^");

		assert_eq!(report.rules.len(), 1);
		assert_eq!(
			report.rules[0].condition.url_filter,
			Some("||good.example^".to_owned())
		);
		assert_eq!(report.stats.skipped_network_filters, 1);
		assert_eq!(
			report.diagnostics[0].code,
			CompileDiagnosticCode::UnsupportedOption
		);
	}

	#[test]
	fn compiles_regex_filters_and_backslash_url_patterns() {
		let report = compile("/ads[0-9]+/\n||escaped\\.example^");

		assert_eq!(report.rules.len(), 2);
		assert_eq!(report.rules[0].condition.url_filter, None);
		assert_eq!(
			report.rules[0].condition.regex_filter.as_deref(),
			Some("ads[0-9]+")
		);
		assert_eq!(
			report.rules[1].condition.regex_filter.as_deref(),
			Some(
				r"^[\w-]+://(?:[^/]+\.)?escaped\\\.example(?:[\x00-\x24\x26-\x2C\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7F]|$)"
			)
		);
		assert_eq!(report.rules[1].condition.url_filter, None);
		assert_eq!(report.stats.regex_rules, 2);
		assert_eq!(report.stats.skipped_network_filters, 0);
		assert!(report.diagnostics.is_empty());
	}

	#[test]
	fn backslash_pattern_conversion_preserves_abp_wildcards_and_anchors() {
		assert_eq!(
			compile_abp_url_pattern_regex(r"|/ads\*banner^|").unwrap(),
			r"^/ads\\.*banner(?:[\x00-\x24\x26-\x2C\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7F]|$)"
		);
	}

	#[test]
	fn backslash_patterns_share_the_regex_rule_quota() {
		let parsed = parse_filter_list("||escaped\\.example^\n||normal.example^");
		let report = compile_filter_list(
			&parsed,
			CompileOptions {
				limits: DnrLimits {
					max_rules: 10,
					max_regex_rules: 0,
				},
				first_rule_id: 1,
			},
		);

		assert_eq!(report.rules.len(), 1);
		assert_eq!(report.rules[0].id, 1);
		assert_eq!(
			report.rules[0].condition.url_filter.as_deref(),
			Some("||normal.example^")
		);
		assert_eq!(report.stats.regex_rules, 0);
		assert_eq!(report.stats.skipped_network_filters, 1);
		assert_eq!(
			report.diagnostics[0].code,
			CompileDiagnosticCode::RegexRuleLimitExceeded
		);
	}

	#[test]
	fn compiles_regex_end_anchor_and_match_case_option() {
		let report = compile(r"/^https?:\/\/ads\.example\/foo$/$script,match-case");
		let rule = &report.rules[0];

		assert_eq!(
			rule.condition.regex_filter.as_deref(),
			Some(r"^https?:\/\/ads\.example\/foo$")
		);
		assert_eq!(rule.condition.url_filter, None);
		assert_eq!(rule.condition.is_url_filter_case_sensitive, Some(true));
		assert_eq!(rule.condition.resource_types, vec![DnrResourceType::Script]);
		assert_eq!(report.stats.regex_rules, 1);
	}

	#[test]
	fn regex_rule_quota_does_not_block_non_regex_rules() {
		let parsed = parse_filter_list("/first/\n||normal.example^\n/second/");
		let report = compile_filter_list(
			&parsed,
			CompileOptions {
				limits: DnrLimits {
					max_rules: 10,
					max_regex_rules: 1,
				},
				first_rule_id: 1,
			},
		);

		assert_eq!(
			report.rules.iter().map(|rule| rule.id).collect::<Vec<_>>(),
			vec![1, 2]
		);
		assert_eq!(report.stats.regex_rules, 1);
		assert_eq!(report.stats.skipped_network_filters, 1);
		assert_eq!(
			report.diagnostics[0].code,
			CompileDiagnosticCode::RegexRuleLimitExceeded
		);
	}

	#[test]
	fn rejects_non_ascii_and_empty_regex_filters() {
		let report = compile("/café/\n//");
		assert!(report.rules.is_empty());
		assert_eq!(report.stats.skipped_network_filters, 2);
		assert!(report.diagnostics.iter().all(
			|diagnostic| diagnostic.code == CompileDiagnosticCode::UnsupportedRegex
		));
	}

	#[test]
	fn compiles_unicode_domains_to_punycode_and_deduplicates_equivalent_forms() {
		let report = compile(
			"||tracker.example^$domain=BÜCHER.example|xn--bcher-kva.example|~café.example",
		);
		assert_eq!(report.rules.len(), 1);

		let condition = &report.rules[0].condition;
		assert_eq!(
			condition
				.initiator_domains
				.as_ref()
				.expect("included domains"),
			&vec!["xn--bcher-kva.example".to_owned()]
		);
		assert_eq!(
			condition
				.excluded_initiator_domains
				.as_ref()
				.expect("excluded domains"),
			&vec!["xn--caf-dma.example".to_owned()]
		);
		assert!(report.diagnostics.is_empty());
	}

	#[test]
	fn rejects_disallowed_unicode_domain_labels() {
		let report = compile("||tracker.example^$domain=bad\u{0000}label.example");

		assert!(report.rules.is_empty());
		assert_eq!(
			report.diagnostics[0].code,
			CompileDiagnosticCode::UnsupportedDomain
		);
	}

	#[test]
	fn rejects_dns_domains_exceeding_label_and_name_length_limits() {
		let overlong_label = format!("{}.example", "a".repeat(64));
		assert!(!is_dnr_domain(&overlong_label));

		let label = "a".repeat(63);
		let overlong_name = format!("{label}.{label}.{label}.{label}");
		assert_eq!(overlong_name.len(), 255);
		assert!(!is_dnr_domain(&overlong_name));

		for domain in [&overlong_label, &overlong_name] {
			let report = compile(&format!("||tracker.example^$domain={domain}"));
			assert!(report.rules.is_empty());
			assert_eq!(
				report.diagnostics[0].code,
				CompileDiagnosticCode::UnsupportedDomain
			);
		}
	}

	#[test]
	fn configured_rule_limit_is_respected() {
		let parsed =
			parse_filter_list("||one.example^\n||two.example^\n||three.example^");
		let report = compile_filter_list(
			&parsed,
			CompileOptions {
				limits: DnrLimits {
					max_rules: 2,
					max_regex_rules: 0,
				},
				first_rule_id: 1,
			},
		);

		assert_eq!(report.rules.len(), 2);
		assert_eq!(report.stats.skipped_network_filters, 1);
		assert_eq!(report.diagnostics.len(), 1);
		assert_eq!(
			report.diagnostics[0].code,
			CompileDiagnosticCode::RuleLimitExceeded
		);
	}

	#[test]
	fn invalid_first_rule_id_fails_closed() {
		let parsed = parse_filter_list("||ads.example^");
		let report = compile_filter_list(
			&parsed,
			CompileOptions {
				limits: DnrLimits::default(),
				first_rule_id: 0,
			},
		);

		assert!(report.rules.is_empty());
		assert_eq!(report.stats.skipped_network_filters, 1);
		assert_eq!(
			report.diagnostics[0].code,
			CompileDiagnosticCode::InvalidFirstRuleId
		);

		let too_large = compile_filter_list(
			&parsed,
			CompileOptions {
				limits: DnrLimits::default(),
				first_rule_id: u32::MAX,
			},
		);
		assert!(too_large.rules.is_empty());
		assert_eq!(
			too_large.diagnostics[0].code,
			CompileDiagnosticCode::InvalidFirstRuleId
		);
	}

	#[test]
	fn cosmetic_rules_are_deferred_not_miscompiled_as_network_rules() {
		let report = compile("example.com##.ad\n||ads.example^");

		assert_eq!(report.rules.len(), 1);
		assert_eq!(report.stats.cosmetic_filters_deferred, 1);
	}

	#[test]
	fn compiles_option_only_network_filter_without_url_filter() {
		let report = compile("$third-party,xmlhttprequest,domain=mega4upload.net");

		assert_eq!(report.rules.len(), 1);

		let rule = &report.rules[0];
		let condition = &rule.condition;

		assert_eq!(condition.url_filter, None);
		assert_eq!(condition.domain_type, Some(DnrDomainType::ThirdParty));
		assert_eq!(
			condition.resource_types,
			vec![DnrResourceType::XmlHttpRequest]
		);
		assert_eq!(
			condition.initiator_domains,
			Some(vec!["mega4upload.net".to_owned()])
		);

		let json = serde_json::to_value(rule).expect("rule serializes");

		assert!(
			json["condition"].get("urlFilter").is_none(),
			"urlFilter must be omitted when the ABP pattern is empty"
		);
		assert!(json["condition"].get("isUrlFilterCaseSensitive").is_none());
	}

	#[test]
	fn skips_option_only_filter_with_unsupported_popup_option() {
		let report = compile("$popup,domain=example.com");

		assert!(report.rules.is_empty());
		assert_eq!(report.stats.skipped_network_filters, 1);
		assert_eq!(report.diagnostics.len(), 1);

		assert_eq!(report.diagnostics[0].level, CompileDiagnosticLevel::Warning);
		assert_eq!(
			report.diagnostics[0].code,
			CompileDiagnosticCode::UnsupportedOption
		);
	}
}
