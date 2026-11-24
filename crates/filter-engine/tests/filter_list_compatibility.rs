use filter_engine::compiler::{
	CompileDiagnosticCode, CompileOptions, DnrDomainType,
	PRIORITY_IMPORTANT_BLOCK, compile_filter_list, compile_filter_lists,
};
use filter_engine::{
	CosmeticFilter, DiagnosticLevel, Filter, NetworkFilter, ParsedFilterList,
	ResourceType, parse_filter_list,
};

fn count_filter_kinds(parsed: &ParsedFilterList) -> (usize, usize) {
	parsed
		.filters
		.iter()
		.fold((0, 0), |(network, cosmetic), filter| match filter {
			Filter::Network(_) => (network + 1, cosmetic),
			Filter::Cosmetic(_) => (network, cosmetic + 1),
		})
}

#[test]
fn easylist_fixture_parses_and_compiles_the_supported_subset() {
	let parsed = parse_filter_list(include_str!("fixtures/easylist.txt"));

	assert_eq!(count_filter_kinds(&parsed), (5, 1));
	assert_eq!(parsed.diagnostics.len(), 1);
	assert_eq!(parsed.diagnostics[0].level, DiagnosticLevel::Warning);
	assert!(parsed.diagnostics[0].source.contains("#?#"));

	let report = compile_filter_list(&parsed, CompileOptions::default());

	assert_eq!(report.rules.len(), 5);
	assert_eq!(report.stats.network_filters_seen, 5);
	assert_eq!(report.stats.compiled_rules, 5);
	assert_eq!(report.stats.skipped_network_filters, 0);
	assert_eq!(report.stats.cosmetic_filters_deferred, 1);
	assert!(report.diagnostics.is_empty());

	let url_filters: Vec<_> = report
		.rules
		.iter()
		.map(|rule| rule.condition.url_filter.as_deref())
		.collect();
	assert_eq!(
		url_filters,
		[
			Some("&subaffid=%"),
			Some("-ad-manager/"),
			Some("-ads/assets/"),
			Some("/ad/images/*"),
			Some("/ad_counter.aspx"),
		]
	);

	assert_eq!(
		report.rules[0].condition.domain_type,
		Some(DnrDomainType::ThirdParty)
	);
	let excluded_domains = report.rules[2]
		.condition
		.excluded_initiator_domains
		.as_ref()
		.expect("excluded initiator domain");
	assert_eq!(excluded_domains.len(), 1);
	assert_eq!(excluded_domains[0], "web-ads.org");
}

#[test]
fn easyprivacy_fixture_compiles_supported_rules_and_reports_unsupported_modifiers()
 {
	let parsed = parse_filter_list(include_str!("fixtures/easyprivacy.txt"));

	assert_eq!(count_filter_kinds(&parsed), (9, 1));
	assert!(parsed.diagnostics.is_empty());

	let report = compile_filter_list(&parsed, CompileOptions::default());

	assert_eq!(report.rules.len(), 5);
	assert_eq!(report.stats.network_filters_seen, 9);
	assert_eq!(report.stats.compiled_rules, 5);
	assert_eq!(report.stats.skipped_network_filters, 4);
	assert_eq!(report.stats.cosmetic_filters_deferred, 1);
	assert_eq!(report.diagnostics.len(), 4);
	assert!(report.diagnostics.iter().all(|diagnostic| {
		diagnostic.code == CompileDiagnosticCode::UnsupportedOption
	}));

	assert_eq!(report.rules[3].priority, PRIORITY_IMPORTANT_BLOCK);
	assert_eq!(report.rules[4].priority, PRIORITY_IMPORTANT_BLOCK);
	let excluded_domains = report.rules[2]
		.condition
		.excluded_initiator_domains
		.as_ref()
		.expect("excluded initiator domains");
	assert_eq!(excluded_domains.len(), 3);
	assert_eq!(excluded_domains[0], "biletomat.pl");
	assert_eq!(excluded_domains[1], "facebook.com");
	assert_eq!(excluded_domains[2], "jobscore.com");
}

#[test]
fn both_fixtures_keep_independent_dnr_rule_id_ranges() {
	let easylist = parse_filter_list(include_str!("fixtures/easylist.txt"));
	let easyprivacy = parse_filter_list(include_str!("fixtures/easyprivacy.txt"));

	let reports = compile_filter_lists(&[
		(
			&easylist,
			CompileOptions {
				first_rule_id: 101,
				..CompileOptions::default()
			},
		),
		(
			&easyprivacy,
			CompileOptions {
				first_rule_id: 201,
				..CompileOptions::default()
			},
		),
	]);

	assert_eq!(reports.len(), 2);
	assert_eq!(
		reports[0]
			.rules
			.iter()
			.map(|rule| rule.id)
			.collect::<Vec<_>>(),
		vec![101, 102, 103, 104, 105]
	);
	assert_eq!(
		reports[1]
			.rules
			.iter()
			.map(|rule| rule.id)
			.collect::<Vec<_>>(),
		vec![201, 202, 203, 204, 205]
	);
}

#[test]
fn abp_syntax_fixture_covers_common_options_and_preserves_unsupported_syntax() {
	let parsed =
		parse_filter_list(include_str!("fixtures/abp-syntax-compatibility.txt"));

	assert_eq!(count_filter_kinds(&parsed), (15, 4));
	assert_eq!(parsed.diagnostics.len(), 4);
	assert_eq!(
		parsed
			.diagnostics
			.iter()
			.map(|diagnostic| diagnostic.line)
			.collect::<Vec<_>>(),
		vec![24, 25, 26, 27]
	);
	assert!(
		parsed
			.diagnostics
			.iter()
			.all(|diagnostic| diagnostic.level == DiagnosticLevel::Warning)
	);

	let types = find_network_filter(&parsed, "||types.example^");
	assert_eq!(
		types.options.resource_types,
		vec![
			ResourceType::Script,
			ResourceType::Image,
			ResourceType::Stylesheet,
			ResourceType::Object,
			ResourceType::XmlHttpRequest,
			ResourceType::SubFrame,
			ResourceType::Font,
			ResourceType::Media,
			ResourceType::Ping,
			ResourceType::WebSocket,
			ResourceType::Other,
		]
	);
	assert_eq!(
		find_network_filter(&parsed, "||legacy-object.example^")
			.options
			.resource_types,
		vec![ResourceType::Object]
	);

	let negated = find_network_filter(&parsed, "||assets.example^");
	assert_eq!(
		negated.options.excluded_resource_types,
		vec![ResourceType::Image, ResourceType::Script]
	);
	assert_eq!(
		find_network_filter(&parsed, "||tracker.example^")
			.options
			.third_party,
		Some(true)
	);
	assert_eq!(
		find_network_filter(&parsed, "||first-party.example^")
			.options
			.third_party,
		Some(false)
	);
	assert!(
		find_network_filter(&parsed, "*/BannerAd.gif")
			.options
			.match_case
	);

	let domain_scoped = find_network_filter(&parsed, "||cdn.example/path^");
	assert_eq!(domain_scoped.options.domains.len(), 2);
	assert_eq!(domain_scoped.options.domains[0].domain, "example.com");
	assert!(domain_scoped.options.domains[0].include);
	assert_eq!(domain_scoped.options.domains[1].domain, "news.example.com");
	assert!(!domain_scoped.options.domains[1].include);

	assert_eq!(
		find_network_filter(&parsed, "||signed.example^")
			.options
			.sitekeys
			.iter()
			.map(String::as_str)
			.collect::<Vec<_>>(),
		vec!["ABCD1234", "EFGH5678"]
	);

	let page_exception = find_network_filter(&parsed, "||trusted.example^");
	assert!(page_exception.exception);
	assert!(page_exception.options.document);
	assert!(page_exception.options.elemhide);
	assert!(page_exception.options.generichide);
	assert!(page_exception.options.genericblock);
	assert_eq!(
		page_exception
			.options
			.unsupported
			.iter()
			.map(String::as_str)
			.collect::<Vec<_>>(),
		vec!["document", "elemhide", "generichide", "genericblock"]
	);

	assert!(
		find_network_filter(&parsed, "||important.example^")
			.options
			.important
	);
	assert!(
		find_network_filter(&parsed, "||cancelled.example^")
			.options
			.badfilter
	);
	assert_eq!(
		find_network_filter(&parsed, "/ads[0-9]+\\.example/")
			.options
			.resource_types,
		vec![ResourceType::Script]
	);
	assert_eq!(
		find_network_filter(&parsed, r"foo\$bar").pattern,
		r"foo\$bar"
	);

	let option_only = find_network_filter(&parsed, "");
	assert_eq!(option_only.options.third_party, Some(true));
	assert_eq!(
		option_only.options.resource_types,
		vec![ResourceType::XmlHttpRequest]
	);
	assert_eq!(option_only.options.domains[0].domain, "example.com");

	let unsupported = find_network_filter(&parsed, "||unsupported.example^");
	assert_eq!(
		unsupported
			.options
			.unsupported
			.iter()
			.map(String::as_str)
			.collect::<Vec<_>>(),
		vec![
			"popup",
			"webrtc",
			"webbundle",
			"csp=script-src 'none'",
			"redirect=trusted-resource",
		]
	);

	let domain_cosmetic = find_cosmetic_filter(&parsed, ".ad-slot");
	assert_eq!(domain_cosmetic.domains.len(), 2);
	assert_eq!(domain_cosmetic.domains[0].domain, "example.com");
	assert_eq!(domain_cosmetic.domains[1].domain, "news.example.com");
	assert!(!domain_cosmetic.exception);
	assert!(find_cosmetic_filter(&parsed, ".sponsor").exception);
	assert_eq!(
		find_cosmetic_filter(&parsed, ".global-ad {display:none!important;}")
			.selector,
		".global-ad {display:none!important;}"
	);
	assert_eq!(
		find_cosmetic_filter(&parsed, r##"[data-rule="#?#"][data-script="#$#"]"##)
			.selector,
		r##"[data-rule="#?#"][data-script="#$#"]"##
	);

	// Syntactically recognized does not mean representable by DNR. The
	// compiler must reject signed/page-scoped and newer modifier semantics
	// instead of dropping their conditions and emitting broader rules.
	// Grant URL-modification permission here so this fixture isolates the
	// remaining unsupported modifiers rather than the separate permission gate.
	let report = compile_filter_list(
		&parsed,
		CompileOptions {
			allow_url_modification: true,
			..CompileOptions::default()
		},
	);
	assert_eq!(report.stats.network_filters_seen, 15);
	assert_eq!(report.stats.compiled_rules, 11);
	assert_eq!(report.stats.skipped_network_filters, 4);
	assert_eq!(report.stats.cosmetic_filters_deferred, 4);
	assert_eq!(report.rules.len(), 11);
	assert_eq!(report.diagnostics.len(), 3);
	assert!(report.diagnostics.iter().all(
		|diagnostic| diagnostic.code == CompileDiagnosticCode::UnsupportedOption
	));
}

fn find_network_filter<'a>(
	parsed: &'a ParsedFilterList,
	pattern: &str,
) -> &'a NetworkFilter {
	parsed
		.filters
		.iter()
		.find_map(|filter| match filter {
			Filter::Network(filter) if filter.pattern == pattern => Some(filter),
			_ => None,
		})
		.unwrap_or_else(|| panic!("missing network filter with pattern: {pattern}"))
}

fn find_cosmetic_filter<'a>(
	parsed: &'a ParsedFilterList,
	selector: &str,
) -> &'a CosmeticFilter {
	parsed
		.filters
		.iter()
		.find_map(|filter| match filter {
			Filter::Cosmetic(filter) if filter.selector == selector => Some(filter),
			_ => None,
		})
		.unwrap_or_else(|| {
			panic!("missing cosmetic filter with selector: {selector}")
		})
}
