//! JavaScript/WASM boundary for parsing ABP lists and compiling DNR rules.
//!
//! Keep the browser-facing DTOs here instead of deriving serialization traits
//! on the filter engine's internal model. This lets the Rust core evolve
//! without accidentally changing the public JavaScript API.

use filter_engine::compiler::{
	CompileDiagnostic, CompileDiagnosticCode, CompileDiagnosticLevel,
	CompileOptions, CompileReport, CompileStats, DnrLimits, DnrRule,
	compile_filter_list, compile_filter_lists as compile_parsed_filter_lists,
};
use filter_engine::model::{
	Diagnostic, DiagnosticLevel, DomainRestriction, Filter, ParsedFilterList,
	ResourceType,
};
use filter_engine::parse_filter_list;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Parse an ABP-style filter list and return typed filters, diagnostics and counts.
///
/// The returned object has the shape:
/// `{ filters, diagnostics, stats }`.
#[wasm_bindgen(js_name = parseFilterList)]
pub fn parse_filter_list_js(input: &str) -> Result<JsValue, JsValue> {
	let report = build_parse_report(input);
	serialize_to_js(&report)
}

/// Parse an ABP-style filter list, compile supported network filters to DNR,
/// and return both parser and compiler diagnostics.
///
/// `options` is optional and currently accepts `maxRules`, `maxRegexRules`, and `firstRuleId`.
#[wasm_bindgen(js_name = compileFilterList)]
pub fn compile_filter_list_js(
	input: &str,
	options: Option<JsValue>,
) -> Result<JsValue, JsValue> {
	let options = parse_compile_options(options)?;
	let report = build_compile_report(input, options);
	serialize_to_js(&report)
}

/// Compile multiple filter lists as one `$badfilter` matching group.
///
/// Each input keeps its own rule-ID range and compile limits. A marker in any
/// input can disable an equivalent rule in any other input.
#[wasm_bindgen(js_name = compileFilterLists)]
pub fn compile_filter_lists_js(inputs: JsValue) -> Result<JsValue, JsValue> {
	let inputs: Vec<BridgeFilterListInput> =
		serde_wasm_bindgen::from_value(inputs).map_err(js_error)?;
	if inputs.is_empty() {
		return Err(js_error("At least one filter list is required."));
	}

	let reports = build_compile_reports(&inputs);
	serialize_to_js(&reports)
}

fn serialize_to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
	serde_wasm_bindgen::to_value(value).map_err(js_error)
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
	JsValue::from_str(&error.to_string())
}

fn parse_compile_options(
	options: Option<JsValue>,
) -> Result<BridgeCompileOptions, JsValue> {
	match options {
		Some(value) if !value.is_null() && !value.is_undefined() => {
			serde_wasm_bindgen::from_value(value).map_err(js_error)
		}
		_ => Ok(BridgeCompileOptions::default()),
	}
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct BridgeCompileOptions {
	/// Maximum number of DNR rules returned in one report.
	max_rules: usize,
	/// Maximum number of regex rules returned in one report.
	max_regex_rules: usize,
	/// First positive DNR rule ID assigned to a compiled rule.
	first_rule_id: u32,
}

impl Default for BridgeCompileOptions {
	fn default() -> Self {
		Self {
			max_rules: DnrLimits::default().max_rules,
			max_regex_rules: DnrLimits::default().max_regex_rules,
			first_rule_id: CompileOptions::default().first_rule_id,
		}
	}
}

impl From<BridgeCompileOptions> for CompileOptions {
	fn from(options: BridgeCompileOptions) -> Self {
		Self {
			limits: DnrLimits {
				max_rules: options.max_rules,
				max_regex_rules: options.max_regex_rules,
			},
			first_rule_id: options.first_rule_id,
		}
	}
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeFilterListInput {
	content: String,
	#[serde(default)]
	options: BridgeCompileOptions,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseReportDto {
	filters: Vec<ParsedFilterDto>,
	diagnostics: Vec<ParserDiagnosticDto>,
	stats: ParseStatsDto,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ParsedFilterDto {
	Network {
		pattern: String,
		exception: bool,
		options: NetworkOptionsDto,
		source_line: usize,
	},
	Cosmetic {
		domains: Vec<DomainRestrictionDto>,
		selector: String,
		exception: bool,
		source_line: usize,
	},
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkOptionsDto {
	domains: Vec<DomainRestrictionDto>,
	resource_types: Vec<ResourceTypeDto>,
	excluded_resource_types: Vec<ResourceTypeDto>,
	third_party: Option<bool>,
	match_case: bool,
	important: bool,
	badfilter: bool,
	sitekeys: Vec<String>,
	document: bool,
	elemhide: bool,
	generichide: bool,
	genericblock: bool,
	unsupported: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DomainRestrictionDto {
	domain: String,
	include: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum ResourceTypeDto {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ParserDiagnosticLevelDto {
	Warning,
	Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParserDiagnosticDto {
	line: usize,
	level: ParserDiagnosticLevelDto,
	message: String,
	source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompilerDiagnosticDto {
	line: usize,
	level: CompilerDiagnosticLevelDto,
	code: CompilerDiagnosticCodeDto,
	message: String,
	pattern: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum CompilerDiagnosticLevelDto {
	Warning,
	Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum CompilerDiagnosticCodeDto {
	UnsupportedOption,
	UnsupportedUrlPattern,
	UnsupportedDomain,
	UnsupportedImportantException,
	InvalidFirstRuleId,
	RuleLimitExceeded,
	RuleIdExhausted,
	UnsupportedRegex,
	RegexRuleLimitExceeded,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseStatsDto {
	total_filters: usize,
	network_filters: usize,
	cosmetic_filters: usize,
	errors: usize,
	warnings: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileReportDto {
	rules: Vec<DnrRule>,
	parser_diagnostics: Vec<ParserDiagnosticDto>,
	compiler_diagnostics: Vec<CompilerDiagnosticDto>,
	parser_stats: ParseStatsDto,
	compiler_stats: CompileStats,
}

fn to_compiler_diagnostic_dto(
	diagnostic: &CompileDiagnostic,
) -> CompilerDiagnosticDto {
	CompilerDiagnosticDto {
		line: diagnostic.line,
		level: match diagnostic.level {
			CompileDiagnosticLevel::Warning => CompilerDiagnosticLevelDto::Warning,
			CompileDiagnosticLevel::Error => CompilerDiagnosticLevelDto::Error,
		},
		code: match diagnostic.code {
			CompileDiagnosticCode::UnsupportedOption => {
				CompilerDiagnosticCodeDto::UnsupportedOption
			}
			CompileDiagnosticCode::UnsupportedUrlPattern => {
				CompilerDiagnosticCodeDto::UnsupportedUrlPattern
			}
			CompileDiagnosticCode::UnsupportedDomain => {
				CompilerDiagnosticCodeDto::UnsupportedDomain
			}
			CompileDiagnosticCode::UnsupportedImportantException => {
				CompilerDiagnosticCodeDto::UnsupportedImportantException
			}
			CompileDiagnosticCode::InvalidFirstRuleId => {
				CompilerDiagnosticCodeDto::InvalidFirstRuleId
			}
			CompileDiagnosticCode::RuleLimitExceeded => {
				CompilerDiagnosticCodeDto::RuleLimitExceeded
			}
			CompileDiagnosticCode::RuleIdExhausted => {
				CompilerDiagnosticCodeDto::RuleIdExhausted
			}
			CompileDiagnosticCode::UnsupportedRegex => {
				CompilerDiagnosticCodeDto::UnsupportedRegex
			}
			CompileDiagnosticCode::RegexRuleLimitExceeded => {
				CompilerDiagnosticCodeDto::RegexRuleLimitExceeded
			}
		},
		message: diagnostic.message.clone(),
		pattern: diagnostic.pattern.clone(),
	}
}

fn build_parse_report(input: &str) -> ParseReportDto {
	let parsed = parse_filter_list(input);
	ParseReportDto {
		filters: parsed.filters.iter().map(to_filter_dto).collect(),
		diagnostics: parsed
			.diagnostics
			.iter()
			.map(to_parser_diagnostic_dto)
			.collect(),
		stats: parse_stats(&parsed),
	}
}

fn build_compile_report(
	input: &str,
	options: BridgeCompileOptions,
) -> CompileReportDto {
	let parsed = parse_filter_list(input);
	let compiled = compile_filter_list(&parsed, options.into());
	build_compile_report_from_parsed(&parsed, compiled)
}

fn build_compile_reports(
	inputs: &[BridgeFilterListInput],
) -> Vec<CompileReportDto> {
	let parsed = inputs
		.iter()
		.map(|input| parse_filter_list(&input.content))
		.collect::<Vec<_>>();
	let compile_inputs = parsed
		.iter()
		.zip(inputs.iter())
		.map(|(parsed, input)| (parsed, input.options.into()))
		.collect::<Vec<_>>();
	let compiled = compile_parsed_filter_lists(&compile_inputs);

	parsed
		.iter()
		.zip(compiled)
		.map(|(parsed, compiled)| {
			build_compile_report_from_parsed(parsed, compiled)
		})
		.collect()
}

fn build_compile_report_from_parsed(
	parsed: &ParsedFilterList,
	compiled: CompileReport,
) -> CompileReportDto {
	let parser_diagnostics = parsed
		.diagnostics
		.iter()
		.map(to_parser_diagnostic_dto)
		.collect();
	let parser_stats = parse_stats(parsed);

	CompileReportDto {
		rules: compiled.rules,
		parser_diagnostics,
		compiler_diagnostics: compiled
			.diagnostics
			.iter()
			.map(to_compiler_diagnostic_dto)
			.collect(),
		parser_stats,
		compiler_stats: compiled.stats,
	}
}

fn to_filter_dto(filter: &Filter) -> ParsedFilterDto {
	match filter {
		Filter::Network(filter) => ParsedFilterDto::Network {
			pattern: filter.pattern.clone(),
			exception: filter.exception,
			options: NetworkOptionsDto {
				domains: filter.options.domains.iter().map(to_domain_dto).collect(),
				resource_types: filter
					.options
					.resource_types
					.iter()
					.map(to_resource_type_dto)
					.collect(),
				excluded_resource_types: filter
					.options
					.excluded_resource_types
					.iter()
					.map(to_resource_type_dto)
					.collect(),
				third_party: filter.options.third_party,
				match_case: filter.options.match_case,
				important: filter.options.important,
				badfilter: filter.options.badfilter,
				sitekeys: filter.options.sitekeys.clone(),
				document: filter.options.document,
				elemhide: filter.options.elemhide,
				generichide: filter.options.generichide,
				genericblock: filter.options.genericblock,
				unsupported: filter.options.unsupported.clone(),
			},
			source_line: filter.source_line,
		},
		Filter::Cosmetic(filter) => ParsedFilterDto::Cosmetic {
			domains: filter.domains.iter().map(to_domain_dto).collect(),
			selector: filter.selector.clone(),
			exception: filter.exception,
			source_line: filter.source_line,
		},
	}
}

fn to_domain_dto(domain: &DomainRestriction) -> DomainRestrictionDto {
	DomainRestrictionDto {
		domain: domain.domain.clone(),
		include: domain.include,
	}
}

fn to_resource_type_dto(resource_type: &ResourceType) -> ResourceTypeDto {
	match resource_type {
		ResourceType::MainFrame => ResourceTypeDto::MainFrame,
		ResourceType::SubFrame => ResourceTypeDto::SubFrame,
		ResourceType::Stylesheet => ResourceTypeDto::Stylesheet,
		ResourceType::Script => ResourceTypeDto::Script,
		ResourceType::Image => ResourceTypeDto::Image,
		ResourceType::Font => ResourceTypeDto::Font,
		ResourceType::Object => ResourceTypeDto::Object,
		ResourceType::XmlHttpRequest => ResourceTypeDto::XmlHttpRequest,
		ResourceType::Ping => ResourceTypeDto::Ping,
		ResourceType::Media => ResourceTypeDto::Media,
		ResourceType::WebSocket => ResourceTypeDto::WebSocket,
		ResourceType::Other => ResourceTypeDto::Other,
	}
}

fn to_parser_diagnostic_dto(diagnostic: &Diagnostic) -> ParserDiagnosticDto {
	ParserDiagnosticDto {
		line: diagnostic.line,
		level: match diagnostic.level {
			DiagnosticLevel::Warning => ParserDiagnosticLevelDto::Warning,
			DiagnosticLevel::Error => ParserDiagnosticLevelDto::Error,
		},
		message: diagnostic.message.clone(),
		source: diagnostic.source.clone(),
	}
}

fn parse_stats(parsed: &ParsedFilterList) -> ParseStatsDto {
	let mut stats = ParseStatsDto {
		total_filters: parsed.filters.len(),
		..ParseStatsDto::default()
	};

	for filter in &parsed.filters {
		match filter {
			Filter::Network(_) => stats.network_filters += 1,
			Filter::Cosmetic(_) => stats.cosmetic_filters += 1,
		}
	}
	for diagnostic in &parsed.diagnostics {
		match diagnostic.level {
			DiagnosticLevel::Error => stats.errors += 1,
			DiagnosticLevel::Warning => stats.warnings += 1,
		}
	}

	stats
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_report_contains_typed_filters_and_parser_diagnostics() {
		let report = build_parse_report(
			"||ads.example^$script,~image,badfilter\nexample.com##.ad\nexample.com##",
		);
		let value = serde_json::to_value(report).expect("parse report serializes");

		assert_eq!(value["filters"][0]["kind"], "network");
		assert_eq!(value["filters"][0]["options"]["resourceTypes"][0], "script");
		assert_eq!(
			value["filters"][0]["options"]["excludedResourceTypes"][0],
			"image"
		);
		assert_eq!(value["filters"][0]["options"]["badfilter"], true);
		assert_eq!(value["filters"][1]["kind"], "cosmetic");
		assert_eq!(value["diagnostics"][0]["level"], "error");
		assert_eq!(value["stats"]["totalFilters"], 2);
		assert_eq!(value["stats"]["networkFilters"], 1);
		assert_eq!(value["stats"]["cosmeticFilters"], 1);
		assert_eq!(value["stats"]["errors"], 1);
	}

	#[test]
	fn parse_report_serializes_sitekeys_and_page_scope_exception_modifiers() {
		let report = build_parse_report(
			"@@||example.com^$document,elemhide,generichide,genericblock,sitekey=keyA|keyB",
		);
		let value = serde_json::to_value(report).expect("parse report serializes");

		let options = &value["filters"][0]["options"];
		assert_eq!(options["document"], true);
		assert_eq!(options["elemhide"], true);
		assert_eq!(options["generichide"], true);
		assert_eq!(options["genericblock"], true);
		assert_eq!(options["sitekeys"][0], "keyA");
		assert_eq!(options["sitekeys"][1], "keyB");
	}

	#[test]
	fn compile_report_keeps_parser_and_compiler_diagnostics_separate() {
		let report = build_compile_report(
			"||ads.example^\n||unsupported.example^$redirect=noopjs\nexample.com##",
			BridgeCompileOptions::default(),
		);
		let value =
			serde_json::to_value(report).expect("compile report serializes");

		assert_eq!(value["rules"].as_array().expect("rules array").len(), 1);
		assert_eq!(value["parserDiagnostics"][0]["level"], "error");
		assert_eq!(value["compilerDiagnostics"][0]["code"], "unsupportedOption");
		assert_eq!(value["parserStats"]["errors"], 1);
		assert_eq!(value["compilerStats"]["compiledRules"], 1);
		assert_eq!(value["compilerStats"]["skippedNetworkFilters"], 1);
	}

	#[test]
	fn js_compile_options_use_camel_case_and_default_missing_fields() {
		let options: BridgeCompileOptions = serde_json::from_value(
			serde_json::json!({ "maxRules": 17, "maxRegexRules": 23 }),
		)
		.expect("camelCase compile options deserialize");

		assert_eq!(options.max_rules, 17);
		assert_eq!(options.max_regex_rules, 23);
		assert_eq!(options.first_rule_id, 1);
		assert!(
			serde_json::from_value::<BridgeCompileOptions>(
				serde_json::json!({ "maxRules": 17, "maxRegexRules": 23, "unknownOption": true }),
			)
			.is_err()
		);
	}

	#[test]
	fn compile_report_serializes_regex_filter_and_stats() {
		let report = build_compile_report(
			r"/^https?:\/\/ads\.example\/foo$/$script,match-case",
			BridgeCompileOptions::default(),
		);
		let value = serde_json::to_value(report).expect("report serializes");

		assert_eq!(
			value["rules"][0]["condition"]["regexFilter"],
			r"^https?:\/\/ads\.example\/foo$"
		);
		assert!(value["rules"][0]["condition"].get("urlFilter").is_none());
		assert_eq!(
			value["rules"][0]["condition"]["isUrlFilterCaseSensitive"],
			true
		);
		assert_eq!(value["compilerStats"]["regexRules"], 1);
	}

	#[test]
	fn compile_options_control_rule_limit_and_first_rule_id() {
		let report = build_compile_report(
			"||one.example^\n||two.example^",
			BridgeCompileOptions {
				max_rules: 1,
				max_regex_rules: 1_000,
				first_rule_id: 42,
			},
		);

		assert_eq!(report.rules.len(), 1);
		assert_eq!(report.rules[0].id, 42);
		assert_eq!(report.compiler_stats.skipped_network_filters, 1);
	}

	#[test]
	fn compile_reports_cancel_matching_rules_across_separate_lists() {
		let inputs = vec![
			BridgeFilterListInput {
				content: "||shared.example^".into(),
				options: BridgeCompileOptions::default(),
			},
			BridgeFilterListInput {
				content: "||shared.example^$badfilter\n||keep.example^".into(),
				options: BridgeCompileOptions {
					first_rule_id: 3501,
					..BridgeCompileOptions::default()
				},
			},
		];
		let reports = build_compile_reports(&inputs);
		let value =
			serde_json::to_value(reports).expect("batch compile reports serialize");

		assert_eq!(value.as_array().expect("reports array").len(), 2);
		assert!(value[0]["rules"].as_array().unwrap().is_empty());
		assert_eq!(value[0]["compilerStats"]["skippedNetworkFilters"], 1);
		assert_eq!(value[1]["rules"].as_array().unwrap().len(), 1);
		assert_eq!(value[1]["rules"][0]["id"], 3501);
		assert_eq!(value[1]["compilerStats"]["skippedNetworkFilters"], 1);
	}
}
