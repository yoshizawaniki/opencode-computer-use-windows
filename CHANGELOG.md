# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

### Added
- Public OSS documentation, contributor/security guidance, CI, installer and uninstaller.
- Deterministic browser-origin mutation policy with a separate attach-mode allowlist.
- Packaging and secret/content safety gates.

### Changed
- Windows/Desktop process mutation is deny-by-default unless explicitly allowlisted.
- Scheduled tasks retain structured status metadata by default instead of raw OpenCode output.
- UIA/Desktop focus verification uses observed foreground process state instead of fixed settle sleeps.

## [0.1.0] - 2026-09-21

First public release.
