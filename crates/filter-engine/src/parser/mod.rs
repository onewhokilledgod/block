//! Parser for the useful common subset of Adblock Plus filter-list syntax.
//!
//! Parsing is intentionally separate from DNR compilation. A syntactically
//! valid filter is not necessarily representable by a browser's DNR API.

use crate::model::{
	CosmeticFilter, Diagnostic, DiagnosticLevel, DomainRestriction, Filter,
	NetworkFilter, NetworkOptions, ParsedFilterList, ResourceType,
};

const COSMETIC_MARKERS: [(&str, bool); 2] = [("#@#", true), ("##", false)];

pub fn parse_filter_list(input: &str) -> ParsedFilterList {
	let mut parsed = ParsedFilterList::default();

	for (index, raw_line) in input.lines().enumerate() {
		let line_number = index + 1;
		let line = raw_line.trim().trim_start_matches('\u{feff}').trim();

		if is_ignored_line(line) {
			continue;
		}

		if contains_cosmetic_marker(line) {
			if let Some(filter) =
				parse_cosmetic(line, line_number, &mut parsed.diagnostics)
			{
				parsed.filters.push(Filter::Cosmetic(filter));
			}
			// Do not reinterpret a malformed cosmetic rule as a network rule.
			continue;
		}

		if line.contains("#?#") || line.contains("#$#") {
			parsed.diagnostics.push(Diagnostic {
				line: line_number,
				level: DiagnosticLevel::Warning,
				message: "Procedural or extended cosmetic syntax is not parsed yet"
					.into(),
				source: line.into(),
			});
			continue;
		}

		if let Some(filter) =
			parse_network(line, line_number, &mut parsed.diagnostics)
		{
			parsed.filters.push(Filter::Network(filter));
		}
	}

	parsed
}

fn is_ignored_line(line: &str) -> bool {
	line.is_empty() || line.starts_with('!') || is_abp_header(line)
}

fn is_abp_header(line: &str) -> bool {
	let Some(version) = line.strip_prefix("[Adblock Plus ") else {
		return false;
	};

	let Some(version) = version.strip_suffix(']') else {
		return false;
	};

	!version.is_empty()
		&& version.split('.').all(|part| {
			!part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
		})
}

fn contains_cosmetic_marker(line: &str) -> bool {
	COSMETIC_MARKERS
		.iter()
		.any(|(marker, _)| line.contains(marker))
}

fn parse_cosmetic(
	line: &str,
	line_number: usize,
	diagnostics: &mut Vec<Diagnostic>,
) -> Option<CosmeticFilter> {
	let (marker, exception, marker_index) = COSMETIC_MARKERS
		.iter()
		.filter_map(|(marker, exception)| {
			line.find(*marker).map(|index| (*marker, *exception, index))
		})
		.min_by_key(|(_, _, index)| *index)?;

	let domain_part = &line[..marker_index];
	let selector = line[marker_index + marker.len()..].trim();

	if selector.is_empty() {
		diagnostics.push(Diagnostic {
			line: line_number,
			level: DiagnosticLevel::Error,
			message: "Cosmetic filter has an empty selector".into(),
			source: line.into(),
		});
		return None;
	}

	let domains = if domain_part.is_empty() {
		// A selector without a domain prefix is a generic cosmetic rule.
		Vec::new()
	} else {
		match parse_cosmetic_domain_list(domain_part) {
			Ok(domains) => domains,
			Err(message) => {
				diagnostics.push(Diagnostic {
					line: line_number,
					level: DiagnosticLevel::Error,
					message,
					source: line.into(),
				});
				return None;
			}
		}
	};

	Some(CosmeticFilter {
		domains,
		selector: selector.to_owned(),
		exception,
		source_line: line_number,
	})
}

fn parse_network(
	line: &str,
	line_number: usize,
	diagnostics: &mut Vec<Diagnostic>,
) -> Option<NetworkFilter> {
	let (exception, body) = match line.strip_prefix("@@") {
		Some(body) => (true, body),
		None => (false, line),
	};

	let (pattern, options_part) = split_pattern_and_options(body);
	let pattern = pattern.trim();

	let has_options = options_part
		.map(|part| part.split(',').any(|option| !option.trim().is_empty()))
		.unwrap_or(false);

	if pattern.is_empty() && !has_options {
		diagnostics.push(Diagnostic {
			line: line_number,
			level: DiagnosticLevel::Error,
			message:
				"Network filter must contain a URL pattern or at least one option"
					.into(),
			source: line.into(),
		});
		return None;
	}

	let mut options = NetworkOptions::default();
	if let Some(options_part) = options_part {
		for option in options_part
			.split(',')
			.map(str::trim)
			.filter(|part| !part.is_empty())
		{
			parse_network_option(
				option,
				&mut options,
				line_number,
				line,
				diagnostics,
			);
		}
	}

	Some(NetworkFilter {
		pattern: pattern.to_owned(),
		exception,
		options,
		source_line: line_number,
	})
}

/// Split ABP options without mistaking `$` inside slash-delimited regexes for the option separator.
fn split_pattern_and_options(body: &str) -> (&str, Option<&str>) {
	if let Some(end) = find_regex_closing_delimiter(body) {
		let suffix = &body[end + 1..];
		if suffix.is_empty() {
			return (body, None);
		}
		if let Some(options) = suffix.strip_prefix('$') {
			return (&body[..=end], Some(options));
		}
	}

	let separator = body.char_indices().rev().find_map(|(index, character)| {
		if character != '$' {
			return None;
		}

		let preceding_backslashes = body[..index]
			.chars()
			.rev()
			.take_while(|character| *character == '\\')
			.count();

		(preceding_backslashes % 2 == 0).then_some(index)
	});

	match separator {
		Some(index) => (&body[..index], Some(&body[index + 1..])),
		None => (body, None),
	}
}

/// Finds the closing slash, ignoring escaped slashes and slashes in character classes.
fn find_regex_closing_delimiter(body: &str) -> Option<usize> {
	if !body.starts_with('/') {
		return None;
	}

	let mut escaped = false;
	let mut in_character_class = false;
	for (index, character) in body.char_indices().skip(1) {
		if escaped {
			escaped = false;
			continue;
		}
		if character == '\\' {
			escaped = true;
			continue;
		}

		match character {
			'[' if !in_character_class => in_character_class = true,
			']' if in_character_class => in_character_class = false,
			'/' if !in_character_class => return Some(index),
			_ => {}
		}
	}

	None
}

fn parse_network_option(
	raw: &str,
	options: &mut NetworkOptions,
	line_number: usize,
	source: &str,
	diagnostics: &mut Vec<Diagnostic>,
) {
	let lower = raw.to_ascii_lowercase();

	match lower.as_str() {
		"third-party" => options.third_party = Some(true),
		"~third-party" => options.third_party = Some(false),
		"match-case" => options.match_case = true,
		"important" => options.important = true,
		_ if lower.starts_with("domain=") => {
			match parse_domain_list(&raw["domain=".len()..]) {
				Ok(domains) if !domains.is_empty() => options.domains.extend(domains),
				Ok(_) => {
					options.unsupported.push(raw.to_owned());
					diagnostics.push(Diagnostic {
						line: line_number,
						level: DiagnosticLevel::Error,
						message: "The domain option must contain at least one domain"
							.into(),
						source: source.into(),
					});
				}
				Err(message) => {
					// Preserve the invalid option so a later compiler cannot
					// accidentally broaden the rule by dropping its scope.
					options.unsupported.push(raw.to_owned());
					diagnostics.push(Diagnostic {
						line: line_number,
						level: DiagnosticLevel::Error,
						message,
						source: source.into(),
					});
				}
			}
		}
		_ => {
			let (resource_type_name, excluded) = match lower.strip_prefix('~') {
				Some(name) => (name, true),
				None => (lower.as_str(), false),
			};

			if let Some(resource_type) =
				parse_resource_type_option(resource_type_name)
			{
				let target = if excluded {
					&mut options.excluded_resource_types
				} else {
					&mut options.resource_types
				};
				target.push(resource_type);
			} else {
				// Preserve unsupported ABP concepts instead of silently dropping
				// semantic information.
				options.unsupported.push(raw.to_owned());
			}
		}
	}
}

fn parse_resource_type_option(option: &str) -> Option<ResourceType> {
	match option {
		"script" => Some(ResourceType::Script),
		"image" => Some(ResourceType::Image),
		"stylesheet" => Some(ResourceType::Stylesheet),
		"object" | "object-subrequest" => Some(ResourceType::Object),
		"xmlhttprequest" => Some(ResourceType::XmlHttpRequest),
		"subdocument" => Some(ResourceType::SubFrame),
		"document" => Some(ResourceType::MainFrame),
		"font" => Some(ResourceType::Font),
		"media" => Some(ResourceType::Media),
		"ping" => Some(ResourceType::Ping),
		"websocket" => Some(ResourceType::WebSocket),
		"other" => Some(ResourceType::Other),
		_ => None,
	}
}

fn parse_domain_list(value: &str) -> Result<Vec<DomainRestriction>, String> {
	parse_domain_tokens(value, '|')
}

fn parse_cosmetic_domain_list(
	value: &str,
) -> Result<Vec<DomainRestriction>, String> {
	// ABP cosmetic prefixes use commas, while the network `$domain=` option
	// uses vertical bars. Keep those grammars distinct.
	parse_domain_tokens(value, ',')
}

fn parse_domain_tokens(
	value: &str,
	separator: char,
) -> Result<Vec<DomainRestriction>, String> {
	if value.trim().is_empty() {
		return Err("Domain list is empty".into());
	}

	let mut domains = Vec::new();
	for token in value.split(separator).map(str::trim) {
		if token.is_empty() {
			return Err("Domain list contains an empty entry".into());
		}

		let (include, domain) = match token.strip_prefix('~') {
			Some(domain) => (false, domain),
			None => (true, token),
		};

		let normalized = domain.trim().trim_start_matches('.').to_ascii_lowercase();
		if normalized.is_empty()
			|| normalized.chars().any(char::is_whitespace)
			|| normalized.contains('/')
		{
			return Err(format!("Invalid domain restriction: {token}"));
		}

		domains.push(DomainRestriction {
			domain: normalized,
			include,
		});
	}

	Ok(domains)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn skips_different_adblock_plus_header_versions() {
		let result = parse_filter_list(
			"[Adblock Plus 2.0]\n\
         [Adblock Plus 1.1]\n\
         ||ads.example^\n",
		);

		assert_eq!(result.filters.len(), 1);
		assert!(result.diagnostics.is_empty());

		let Filter::Network(filter) = &result.filters[0] else {
			panic!("expected network filter");
		};

		assert_eq!(filter.pattern, "||ads.example^");
	}

	#[test]
	fn skips_blank_comments_and_header() {
		let result = parse_filter_list(
			"\u{feff}[Adblock Plus 2.0]\n! title\n\n||ads.example^\n",
		);

		assert_eq!(result.filters.len(), 1);
		assert!(result.diagnostics.is_empty());
	}

	#[test]
	fn parses_network_filter_and_options() {
		let result = parse_filter_list(
			"||tracker.example^$script,third-party,domain=example.com|~news.example,match-case",
		);

		let Filter::Network(filter) = &result.filters[0] else {
			panic!("expected network filter");
		};

		assert_eq!(filter.pattern, "||tracker.example^");
		assert!(!filter.exception);
		assert_eq!(filter.options.third_party, Some(true));
		assert!(filter.options.match_case);
		assert_eq!(filter.options.resource_types, vec![ResourceType::Script]);
		assert_eq!(filter.options.domains.len(), 2);
		assert!(filter.options.domains[0].include);
		assert!(!filter.options.domains[1].include);
		assert!(result.diagnostics.is_empty());
	}

	#[test]
	fn parses_negated_resource_type_options() {
		let result = parse_filter_list(
			"||ads.example^$~image,~script\n||mixed.example^$script,image,~image",
		);
		let Filter::Network(negated) = &result.filters[0] else {
			panic!("expected network filter");
		};
		let Filter::Network(mixed) = &result.filters[1] else {
			panic!("expected network filter");
		};

		assert!(negated.options.resource_types.is_empty());
		assert_eq!(
			negated.options.excluded_resource_types,
			vec![ResourceType::Image, ResourceType::Script]
		);
		assert_eq!(
			mixed.options.resource_types,
			vec![ResourceType::Script, ResourceType::Image]
		);
		assert_eq!(
			mixed.options.excluded_resource_types,
			vec![ResourceType::Image]
		);
		assert!(result.diagnostics.is_empty());
	}

	#[test]
	fn parses_exception_filter() {
		let result = parse_filter_list("@@||ads.example^$image");
		let Filter::Network(filter) = &result.filters[0] else {
			panic!("expected network exception");
		};

		assert!(filter.exception);
		assert_eq!(filter.pattern, "||ads.example^");
		assert_eq!(filter.options.resource_types, vec![ResourceType::Image]);
	}

	#[test]
	fn parses_cosmetic_filter_and_exception() {
		let result = parse_filter_list(
			"example.com,~news.example##.ad-slot\nexample.com#@#.sponsored\n##.generic-ad",
		);

		assert_eq!(result.filters.len(), 3);
		let Filter::Cosmetic(first) = &result.filters[0] else {
			panic!("expected cosmetic filter");
		};
		assert_eq!(first.selector, ".ad-slot");
		assert!(!first.exception);
		assert_eq!(first.domains.len(), 2);

		let Filter::Cosmetic(second) = &result.filters[1] else {
			panic!("expected cosmetic exception");
		};
		assert_eq!(second.selector, ".sponsored");
		assert!(second.exception);

		let Filter::Cosmetic(generic) = &result.filters[2] else {
			panic!("expected generic cosmetic filter");
		};
		assert!(generic.domains.is_empty());
		assert_eq!(generic.selector, ".generic-ad");
	}
	#[test]
	fn regex_end_anchor_is_not_treated_as_an_option_separator() {
		let input = r"/^https?:\/\/ads\.example\/foo$/";
		let (pattern, options) = split_pattern_and_options(input);

		assert_eq!(pattern, input);
		assert_eq!(options, None);
	}

	#[test]
	fn regex_options_are_split_after_the_closing_delimiter() {
		let input = r"/^https?:\/\/ads\.example\/foo$/$script,match-case";
		let (pattern, options) = split_pattern_and_options(input);

		assert_eq!(pattern, r"/^https?:\/\/ads\.example\/foo$/");
		assert_eq!(options, Some("script,match-case"));
	}

	#[test]
	fn slash_inside_regex_character_class_is_not_the_closing_delimiter() {
		let input = r"/assets[/]banner$/$image";
		let (pattern, options) = split_pattern_and_options(input);

		assert_eq!(pattern, r"/assets[/]banner$/");
		assert_eq!(options, Some("image"));
	}

	#[test]
	fn escaped_dollar_is_not_treated_as_option_separator() {
		let (pattern, options) = split_pattern_and_options(r"foo\$bar");
		assert_eq!(pattern, r"foo\$bar");
		assert_eq!(options, None);
	}

	#[test]
	fn preserves_unknown_options_for_later_compilation() {
		let result = parse_filter_list("||ads.example^$script,redirect= noopjs");
		let Filter::Network(filter) = &result.filters[0] else {
			panic!("expected network filter");
		};

		assert_eq!(filter.options.unsupported, vec!["redirect= noopjs"]);
	}

	#[test]
	fn reports_malformed_cosmetic_filter() {
		let result = parse_filter_list("example.com##");
		assert!(result.filters.is_empty());
		assert_eq!(result.diagnostics.len(), 1);
		assert_eq!(result.diagnostics[0].level, DiagnosticLevel::Error);
	}

	#[test]
	fn parses_network_filter_without_url_pattern() {
		let result =
			parse_filter_list("$third-party,xmlhttprequest,domain=mega4upload.net");

		assert_eq!(result.filters.len(), 1);
		assert!(result.diagnostics.is_empty());

		let Filter::Network(filter) = &result.filters[0] else {
			panic!("expected network filter");
		};

		assert_eq!(filter.pattern, "");
		assert_eq!(filter.options.third_party, Some(true));

		assert_eq!(
			filter.options.resource_types,
			vec![ResourceType::XmlHttpRequest]
		);

		assert_eq!(filter.options.domains.len(), 1);
		assert_eq!(filter.options.domains[0].domain, "mega4upload.net");
	}

	#[test]
	fn rejects_network_filter_without_pattern_or_options() {
		let result = parse_filter_list("$");

		assert!(result.filters.is_empty());
		assert_eq!(result.diagnostics.len(), 1);
		assert_eq!(result.diagnostics[0].level, DiagnosticLevel::Error);
	}

	#[test]
	fn parses_option_only_exception_with_unsupported_option() {
		let result = parse_filter_list("@@$generichide,domain=example.com");

		assert_eq!(result.filters.len(), 1);
		assert!(result.diagnostics.is_empty());

		let Filter::Network(filter) = &result.filters[0] else {
			panic!("expected network exception");
		};

		assert!(filter.exception);
		assert_eq!(filter.pattern, "");

		assert!(
			filter
				.options
				.unsupported
				.contains(&"generichide".to_owned())
		);
	}
}
