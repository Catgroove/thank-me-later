# Agent Instructions

## Package boundaries

- Core packages (`packages/core` and `packages/view`) must stay unaware of concrete Step implementations.
- Do not special-case default Step names, default pipeline order, or default Step behavior in core packages.
- Core packages provide generic capabilities: pipeline assembly, the engine, providers, event folding, and rendering of generic Step metadata.
- Concrete pipeline behavior belongs in pipeline packages. The default pipeline in `packages/defaults` is one pipeline among many, not something core packages may assume.
- If a renderer needs labels or grouping, pass that as generic Step metadata from the Step definition instead of deriving it from Step names in `packages/view`.
