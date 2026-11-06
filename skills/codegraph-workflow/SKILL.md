---
name: codegraph-workflow
description: "Trigger: investigate, analyze, refactor, fix, or review code. Use CodeGraph to navigate indexed code before broad symbol searches."
---

# CodeGraph workflow

## Activation Contract

Use this workflow for code investigation, analysis, refactoring, fixes,
or review. For unrelated tasks, do not invoke CodeGraph just because
this skill is available.

## Hard Rules

- When an applicable index and a CodeGraph tool are available, use
  CodeGraph before broad symbol searches.
- Do not run `codegraph index` before every query.
- Do not initialize or update an index independently of the package's
  startup policy, unless the user explicitly requests it.
- Honor an explicit user request to index or fully reindex. First check
  for ongoing initialization, indexing, or synchronization where possible;
  do not start another operation while one is running. If you cannot tell
  whether it is safe, explain the uncertainty instead of assuming it is.
- If the extension blocks an explicitly requested rebuild because an index
  already exists, use the escape hatch named in the block reason. Do not use
  it to bypass the guard for routine instructions.
- Treat CodeGraph results as navigation hints, not authoritative source.
  Confirm relevant behavior and findings against the source files.

## Decision Gates

- For exact strings, filenames, configuration, or a known file, use the
  appropriate file or search tool directly.
- If CodeGraph is unavailable, fails, or has no applicable index, continue
  with the available read and search tools. Do not repeatedly retry it.
- If indexing or synchronization is still running, do not assume the
  results are current. Do not start another index operation.
- When working across projects or worktrees, use only an index and a
  project path the current tool and the user's scope permit.

## Delegation

- If a subagent cannot use CodeGraph, the parent may query it and include
  relevant findings and paths in the handoff.
- Respect each subagent's tool restrictions. Do not require `bash` from
  a read-only explorer.

## Output Contract

When relevant, report unavailable or potentially stale index evidence and
distinguish CodeGraph findings from behavior verified in source.
