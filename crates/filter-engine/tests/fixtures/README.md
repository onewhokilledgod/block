# Filter-list compatibility fixtures

These are small, deterministic excerpts from the official EasyList and
EasyPrivacy subscriptions. They are test data only; the extension does not ship
or fetch these files at runtime. Unit and integration tests must remain offline
and deterministic, so they do not download the live subscriptions.

## Pinned sources

- **EasyList** — version `202611231946`, upstream commit
  `06aab8654f212b6a2f78efb80abd631ff4d398ca`, last modified 2026-11-23.
  Excerpted one-based source lines: 20, 22, 26, 129, 139, 75666, 75698.
  Source: <https://easylist.to/easylist/easylist.txt>
- **EasyPrivacy** — version `202611231929`, upstream commit
  `003c3a9e0e650dad7ee409246920fbc0d4c079a6`, last modified 2026-11-23.
  Excerpted one-based source lines: 20, 21, 28, 18215, 18458, 18464,
  18467, 18475, 18480, 18501.
  Source: <https://easylist.to/easylist/easyprivacy.txt>

The excerpts retain attribution to **The EasyList authors**. EasyList
repository content is dual-licensed under GPL-3.0-or-later or
CC-BY-SA-3.0-or-later; see <https://easylist.to/pages/licence.html>.

## Coverage

The EasyList excerpt exercises ordinary network patterns, request-type
inclusions and exclusions, domain exclusions, third-party matching, a
procedural cosmetic syntax diagnostic, and a standard cosmetic rule.

The EasyPrivacy excerpt exercises tracker patterns, multi-type and domain
conditions, important rules, scriptlet cosmetic syntax, and modifiers that the
current compiler deliberately reports as unsupported (`redirect`, `method`,
`redirect-rule`, and `csp`). The latter must never be silently dropped to
produce a broader rule.

When refreshing these excerpts, update the pinned upstream versions and keep
only representative lines that exercise intentional parser/compiler behavior.

The separate `abp-syntax-compatibility.txt` fixture is a curated syntax matrix
based on the ABP filter documentation. Its example domains and rules are
synthetic; it is not copied from a live subscription. It exercises resource
types, behavior options, option-only filters, sitekey and page-scope exceptions,
cosmetic filters with CSS declaration blocks, and unsupported extended
cosmetic/snippet markers. Marker-like text inside a CSS attribute selector is
included to guard against treating selector contents as rule separators.
