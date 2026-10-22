# Vendored: Meterless H-MEM reference

This folder is a copy of the H-MEM engine from the Meterless open-source repository. It is a pre-existing open-source component, declared as such in the hackathon submission.

- Source: https://github.com/Meterless/Meterless, folders `engines/hmem/reference/src` and `engines/hmem/conformance`
- Commit: `1742dec56a66e58eef9dda2d2b865823758ca8cd` (2026-10-19)
- Copied: 2026-10-22, unmodified. The reference's own `package.json` was left out: it only lists its test tooling.
- License: Apache License 2.0, in `LICENSE` next to this file.

`npm run conformance:hmem` runs the engine's conformance suite against this copy. The runner's default path (`../reference/src/index.ts`) points here, so no environment variable is needed.
