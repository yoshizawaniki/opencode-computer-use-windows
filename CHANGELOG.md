# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

## [0.1.1] - 2026-09-22

### Added
- Dedicated real Windows clipboard E2E that restores the previous clipboard contents.

### Changed
- Windows UIA value writes are independently re-observed before success is reported.
- UIA focus verification now waits on observed keyboard-focus state instead of a fixed sleep.
- Secret Broker subprocess timeout handling is hardened.
- Hosted browser CI skips only the DPAPI-backed secret-injection integration path while retaining Secret Broker unit coverage.

## [0.1.0] - 2026-09-21

### Added
- Public OSS documentation, contributor/security guidance, CI, installer and uninstaller.
- Deterministic browser-origin mutation policy with a separate attach-mode allowlist.
- Packaging and secret/content safety gates.

### Changed
- Windows/Desktop process mutation is deny-by-default unless explicitly allowlisted.
- Scheduled tasks retain structured status metadata by default instead of raw OpenCode output.
- UIA/Desktop focus verification uses observed foreground process state instead of fixed settle sleeps.

First public release.
