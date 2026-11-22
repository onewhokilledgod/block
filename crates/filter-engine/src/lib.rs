//! Core parser and normalized rule model for the ad-blocking engine.
//!
//! This crate deliberately has no browser or WebAssembly dependencies. It can
//! be tested natively and later reused by the WASM bridge and native tooling.

pub mod model;
pub mod parser;

pub use model::{
	CosmeticFilter, Diagnostic, DiagnosticLevel, DomainRestriction, Filter,
	NetworkFilter, NetworkOptions, ParsedFilterList, ResourceType,
};
pub use parser::parse_filter_list;
