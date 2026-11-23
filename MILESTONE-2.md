# Milestone 2 — DNR compiler

## What this stage adds

`filter-engine` can now compile the supported network-filter subset into
`declarativeNetRequest` JSON objects. The compiler is browser-independent and
has no WebExtension dependencies; the TypeScript adapter validates and installs
these rules through the browser's DNR API.

### Supported in this milestone

- ABP URL filters using DNR-compatible `urlFilter` tokens (`*`, `|`, `||`, `^`).
- Blocking rules and `@@` allow/exception rules.
- `$important` blocking rules.
- `$domain=` inclusion and exclusion lists, mapped to
  `initiatorDomains` / `excludedInitiatorDomains`; Unicode domains are
  normalized to ASCII/Punycode with IDNA before DNR emission.
- `$third-party` and `~third-party`, mapped to `domainType`.
- Positive and negated resource-type options such as `$script` and `$~image`;
  negations are compiled to an explicit DNR resource-type set. `$match-case`
  is also supported.
- Unqualified filters get an explicit common DNR resource-type set including
  top-level navigations.
- Configurable rule quotas and deterministic positive rule IDs.
- ABP regular-expression filters are emitted as DNR `regexFilter` candidates; the browser adapter validates each expression with `isRegexSupported()` before installation.
- ABP simple URL patterns containing literal backslashes are lowered to RE2 candidates and validated by the browser before installation.
- Separate regex-rule quotas and diagnostics for expressions that cannot be represented safely.
- Structured diagnostics for rules which cannot be compiled safely.

### Deliberately deferred

- Unknown modifiers, redirect/csp/header modifiers, and advanced options.
  A filter containing any unrecognized option is skipped as a whole.
- Cosmetic filters. They are counted as deferred for the separate cosmetic
  engine and are not turned into network rules.

## Rule precedence

The compiler emits the following priorities:

| Rule class | DNR action | Priority |
| --- | --- | ---: |
| Ordinary ABP network filter | `block` | 100 |
| ABP exception (`@@`) | `allow` | 200 |
| Important blocking filter (`$important`) | `block` | 300 |

This makes ordinary exceptions beat ordinary blocks, while important blocks
beat exceptions. Do not change these priorities independently without adding
matching-precedence tests.

## Browser limits

`DnrLimits::default()` uses the current cross-browser dynamic-rule ceiling of
5,000 rules. `DnrLimits::chrome_dynamic()` uses 30,000, and
`DnrLimits::firefox_dynamic()` uses 5,000. The browser adapter must still read
runtime capabilities and verify the actual quota before installing rules.

`DnrLimits::default()` also caps regex candidates at 1,000 per ruleset.
The extension validates candidate expressions with the target browser's RE2
implementation before installing them; unsupported candidates are skipped
with diagnostics. The browser remains authoritative for compiled-regex size
and syntax limits. The compiler also uses positive 31-bit rule IDs to stay
within the browser API integer range.

The default resource-type set is an explicit common baseline so generic ABP
filters can match top-level navigations too. Newer vendor-specific request
types will be added through browser capability profiles.

## Run checks

```bash
cargo fmt --all -- --check
cargo test -p filter-engine
cargo clippy -p filter-engine --all-targets -- -D warnings
```
