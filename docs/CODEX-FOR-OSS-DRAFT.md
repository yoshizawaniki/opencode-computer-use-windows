# Codex for Open Source application draft

> Draft only. Do not submit this text until the repository is public and every factual statement is rechecked against the then-current project state and OpenAI eligibility criteria.

## Project

opencode-computer-use is an independent MCP server that gives OpenCode browser and Windows Computer Use capabilities with deterministic permission boundaries and post-action verification.

It connects a coding-agent workflow to browser DOM/accessibility automation, Windows UI Automation, visual verification, workflow record/replay, and a local Secret Broker. Its central design rule is observe -> act -> re-observe -> verify: successful input dispatch is not treated as successful task completion without observed state.

## Why it matters to the ecosystem

Coding agents can often change source code but cannot verify failures that only appear in a real browser or native Windows GUI. This project provides that missing verification layer through MCP rather than requiring a fork of OpenCode itself.

The project also centralizes security mechanisms that GUI automation otherwise tends to implement ad hoc:

- exact-origin browser mutation scopes;
- deny-by-default Windows process mutation scopes;
- OpenCode host permission gates for high-impact operations;
- origin/process-bound Secret Broker injection without returning resolved secret values to the model;
- fail-closed workflow replay rules;
- browser-profile/artifact packaging protections.

## Maintenance workload

Maintenance includes compatibility work across OpenCode configuration/permission behavior, MCP SDK changes, Playwright/Chrome behavior, Windows UI Automation and SendInput behavior, installer/uninstaller safety, security regression tests, issue triage, and release verification on a real interactive Windows environment.

## Current usage and adoption

The project originated from real local use with OpenCode 1.18.31. At the time of preparing this draft it should **not** claim broad external adoption, stars, or a user community. If the repository is newly public, say so plainly. Replace this section only with measured public evidence when such evidence actually exists.

## Security and code quality

The public-ready tree separates contributor-safe tests from explicit real-machine integration gates, includes a threat model, tracked-file/tarball secret and content checks, dependency auditing/license review, conservative JSONC installer/uninstaller behavior, and release gates for browser, Chrome attach, Windows UIA/Desktop, workflow replay, Secret Broker, visual verification, and Task Scheduler behavior.

## Active maintenance evidence to include at submission time

Before submission, link to the real public evidence that exists at that time, such as:

- recent commits and releases;
- resolved and open issues;
- pull-request review activity;
- security fixes;
- compatibility updates;
- release notes;
- reproducible CI/local release-gate results.

Do not manufacture activity or describe self-use as broad adoption.
