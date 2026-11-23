export type DiagnosticLevel = "warning" | "error";

export type ParsedResourceType =
	| "mainFrame"
	| "subFrame"
	| "stylesheet"
	| "script"
	| "image"
	| "font"
	| "object"
	| "xmlHttpRequest"
	| "ping"
	| "media"
	| "webSocket"
	| "other";

export interface DomainRestriction {
	domain: string;
	include: boolean;
}

export interface NetworkOptions {
	domains: DomainRestriction[];
	resourceTypes: ParsedResourceType[];
	excludedResourceTypes: ParsedResourceType[];
	thirdParty: boolean | null;
	matchCase: boolean;
	important: boolean;
	badfilter: boolean;
	sitekeys: string[];
	document: boolean;
	elemhide: boolean;
	generichide: boolean;
	genericblock: boolean;
	unsupported: string[];
}

export interface NetworkFilter {
	kind: "network";
	pattern: string;
	exception: boolean;
	options: NetworkOptions;
	sourceLine: number;
}

export interface CosmeticFilter {
	kind: "cosmetic";
	domains: DomainRestriction[];
	selector: string;
	exception: boolean;
	sourceLine: number;
}

export type ParsedFilter = NetworkFilter | CosmeticFilter;

export interface ParserDiagnostic {
	line: number;
	level: DiagnosticLevel;
	message: string;
	source: string;
}

export interface ParseStats {
	totalFilters: number;
	networkFilters: number;
	cosmeticFilters: number;
	errors: number;
	warnings: number;
}

export interface ParseReport {
	filters: ParsedFilter[];
	diagnostics: ParserDiagnostic[];
	stats: ParseStats;
}

export interface CompileOptions {
	maxRules?: number;
	maxRegexRules?: number;
	firstRuleId?: number;
}

export interface FilterListCompileInput {
	content: string;
	options?: CompileOptions;
}

export type DnrActionType = "block" | "allow";

export type CompilerDiagnosticCode =
	| "unsupportedOption"
	| "unsupportedUrlPattern"
	| "unsupportedDomain"
	| "unsupportedImportantException"
	| "invalidFirstRuleId"
	| "ruleLimitExceeded"
	| "regexRuleLimitExceeded"
	| "ruleIdExhausted"
	| "unsupportedRegex";

export interface DnrAction {
	type: DnrActionType;
}

export interface DnrCondition {
	urlFilter?: string;
	regexFilter?: string;
	resourceTypes: string[];
	isUrlFilterCaseSensitive?: boolean;
	initiatorDomains?: string[];
	excludedInitiatorDomains?: string[];
	domainType?: "firstParty" | "thirdParty";
}

export interface DnrRule {
	id: number;
	priority: number;
	action: DnrAction;
	condition: DnrCondition;
}

export interface CompilerDiagnostic {
	line: number;
	level: DiagnosticLevel;
	code: CompilerDiagnosticCode;
	message: string;
	pattern: string;
}

export interface CompilerStats {
	networkFiltersSeen: number;
	compiledRules: number;
	skippedNetworkFilters: number;
	cosmeticFiltersDeferred: number;
	regexRules: number;
}

export interface CompileReport {
	rules: DnrRule[];
	parserDiagnostics: ParserDiagnostic[];
	compilerDiagnostics: CompilerDiagnostic[];
	parserStats: ParseStats;
	compilerStats: CompilerStats;
}

export interface FilterEngine {
	parseFilterList(input: string): ParseReport;

	compileFilterList(input: string, options?: CompileOptions): CompileReport;

	compileFilterLists(inputs: FilterListCompileInput[]): CompileReport[];
}

export function initializeFilterEngine(): Promise<FilterEngine>;
