use filter_engine::compiler::{
	CompileDiagnosticCode, CompileOptions, DnrDomainType,
	PRIORITY_IMPORTANT_BLOCK, compile_filter_list, compile_filter_lists,
};
use filter_engine::{
	DiagnosticLevel, Filter, ParsedFilterList, parse_filter_list,
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
