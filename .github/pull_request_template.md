## What & why

<!-- One logical change per PR. Link the issue this addresses. -->

## Wire-contract checklist

- [ ] No span names, attributes, metrics, resource attributes, or load-bearing
      string formats changed — **or** `src/contract.ts` + `CONTRACT.md` are
      updated and `OPENCLAW_SCHEMA_VERSION` is bumped with a changelog note.
- [ ] No placeholder values emitted for unresolvable attributes (omit instead).
- [ ] Any new config key is declared in **both** `src/config.ts` and
      `openclaw.plugin.json` (the closed manifest schema crash-loops the
      gateway otherwise).

## Tests

- [ ] New/changed behavior is covered by tests (`npm test` green locally).
