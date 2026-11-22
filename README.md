# mend: one patch tool for every AI edit format

[![Build mend, one patch tool for every AI edit format](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sybl2710-creator/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sybl2710-creator/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Each format is read as `SPEC.md` says, and every file is changed or nothing is.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=NAME`: `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, detected per SPEC.md section 4).
- `--check`: do everything but write — same output and exit code, no file created, changed or deleted.
- `--strict`: match lines exactly (tier 0 only).
- `PATCH` is the path of the patch file, relative to the working directory. When absent or `-`, the patch is read from standard input.

Matching finds the lines each edit names at the first of three tiers: exact, trailing-whitespace-insensitive, then leading-and-trailing-whitespace-insensitive (with re-indentation). A failed edit changes nothing, later edits still run, and when any edit failed no file is written (atomic).

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's trial runner (kept as-is).
- `check.ts`: run the practice set — `node check.ts ../program/generator/practice.json`.
- `SPEC.md`: the full specification; it is the whole contract.

## License

MIT — see `LICENSE`.
