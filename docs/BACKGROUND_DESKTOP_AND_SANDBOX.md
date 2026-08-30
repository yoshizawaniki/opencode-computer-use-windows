# Background Desktop & Sandbox — comparison and current state

Design doc Phase 8 asks for two things: (1) compare isolated-execution options for running
Computer Use away from the user's normal desktop, and recommend one; (2) ensure the agent
doesn't have unrestricted PC access, across six boundaries (filesystem, process, network,
credentials, browser profile, external communication).

Per commander's direction: Background Desktop is a comparison + recommendation only (no
implementation required). Sandbox requires the boundaries to actually exist — most of them
already do, from Phase 0–5 security work; this document fills in what was still missing.

## Background Desktop — comparison

Real finding from this session (see `src/uia.ps1`'s `window_at_point`/`element_at_point` and
`desktop_annotate_point`'s test in `tests/uia-smoke.mjs`): UI Automation and SendInput act on
the **shared physical desktop session** — a busy desktop with many real windows genuinely
interferes with point-based hit tests and OS focus (documented directly: another real
window, `ChatGPT.exe`, was topmost at a target pixel during testing). This is the concrete
motivation for wanting an isolated desktop at all — it's not hypothetical.

| Option | Isolation | Cost/complexity | Verdict |
|---|---|---|---|
| **Separate Windows session** (`tscon`/a second interactive session on the same login, or a second local user logged in via Fast User Switching) | Real: own desktop, own foreground/z-order, own window list. Same OS instance, same filesystem/registry/network. | Low — no new software. `mstsc /v:localhost` into a second session works on Windows 10/11 Pro+ (`fDenyTSConnections` off) without a full RDP server license issue since it's local. | **Recommended default.** Solves the actual, measured problem (desktop contention) with existing OS features. |
| **RDP into the same machine** | Same as above, via the RDP protocol specifically. | Low, same mechanism as "separate session" — this row exists mainly to note that "RDP" and "separate session" are the same thing on Windows, not two different options. | Same as separate session — pick this framing if a *remote* client is what's wanted (ties into Phase 8's Remote Control), not for local isolation alone. |
| **Windows Sandbox** (`WindowsSandbox.exe`) | Strong: disposable, isolated OS instance, own kernel-level namespace, resets on close. | Medium — requires Windows 10/11 **Pro/Enterprise** (not available on Home, which `systeminfo`/`docs/`… — this machine's actual edition should be checked before relying on this), and a fresh container boots in seconds but starts with no profile/no browser/no this-repo present unless explicitly mapped in via a `.wsb` config (folder mapping, startup command). | Good for a genuinely disposable one-shot task; **not** a good fit for anything needing persistent state (browser profile, this project's `artifacts/`, registered secrets) without extra config work each time. |
| **VM** (Hyper-V, VirtualBox, etc.) | Strongest: fully separate OS, separate everything. | High — a VM needs provisioning, updates, licensing (if Windows), and its own copy of Node/Playwright/this project, or a shared-folder setup. Slower to start than a session or Windows Sandbox. | Overkill for the problem actually observed (desktop contention). Reasonable ONLY if the requirement becomes "the agent must never touch the user's real filesystem/registry at all," which is a Sandbox-boundary concern (below), not a Background-Desktop one. |

**Recommendation: a separate Windows session (via a second local session or `mstsc
/v:localhost`), not a VM or Windows Sandbox, as the default.** It solves the actual measured
problem — desktop/focus contention with the user's real, concurrently-used windows — with
existing OS mechanisms, no new licensing, no provisioning, and it keeps this project's
filesystem/profile/secrets store reachable without extra config. Windows Sandbox is worth
revisiting if/when a genuinely disposable, no-persistent-state execution mode is wanted (e.g.
running an UNTRUSTED workflow file from Record & Replay) — that's a different requirement
than "don't fight the user for the mouse," and is noted as a future option, not built now
(YAGNI: no current caller needs it).

Not implemented in this pass — this is a recommendation for the user/operator to set up
(launching an MCP session inside a second local Windows session), not something `server.js`
itself can arrange; it doesn't control which session it's launched from.

## Sandbox — boundary-by-boundary state

The design doc's six categories, filled in from what actually exists in this codebase today
(not aspirational):

| Boundary | State | Where |
|---|---|---|
| **Filesystem** | Partial. Upload/download/preview/checkpoint/workflow paths are scoped to specific subdirectories under `artifacts/` (`assertUploadAllowed`, `downloadPath`, `assertPreviewAllowed`, `CHECKPOINTS_DIR`, `WORKFLOW_DIR`). `file://` navigation is scoped to the project root. **Gap:** nothing stops `desktop_launch_app`/`windows_set_value`/etc. from reading or writing an arbitrary file through a NATIVE APP's own file dialogs — those tools operate the app, and the app has the user's normal filesystem permissions. This is an accepted limit of Tool-level (not OS-level) sandboxing. |
| **Process** | Real. `allowlist.js`'s `assertProcessAllowed` gates every desktop/windows mutating call by process name (default: notepad.exe, opencode.exe, systemsettings.exe), configurable via `OPENCODE_CU_WINDOW_ALLOWLIST`. `desktop_kill_process` additionally refuses self/parent/reserved pids unconditionally. **Known theoretical gap (noted since Phase 3):** TOCTOU — the process at a pid/hwnd could change between the allowlist check and the actual mutation on a sufficiently adversarial timeline; accepted, not fixed (see `src/PERMISSION_COVERAGE.md`). |
| **Network** | Partial, at the Tool layer only. `browser_evaluate` (arbitrary JS with real cookies/fetch) is disabled by default, requires an env var AND config permission, and is hard-refused while attached to a real Chrome. Ordinary browser navigation/fetching is otherwise unrestricted (that's the point of a browser tool) — this is Tool-level policy, not an OS/process network boundary; nothing here uses a firewall rule or network namespace. |
| **Credentials** | Real, and the most built-out boundary. The Secret Broker (`src/secret-broker.js`, `src/secret-resolve.ps1`) stores values DPAPI-encrypted, resolves only by name with scope binding (origin/process), and the LLM never sees a resolved value — `redaction.js`'s value-based scrub also catches read-back through unrelated tools. Registration is CLI-only (`scripts/secret-cli.ps1`), no Tool can write a secret value. |
| **Browser profile** | Real. The owned/launch-mode browser uses a dedicated persistent profile under `artifacts/browser-profile/`, never the user's real Chrome profile. Attach mode (`browser_attach`) is explicit-opt-in (ask-gated), and even then existing tabs aren't auto-instrumented until selected — see Phase 5's design. |
| **External communication** | Partial. `scheduled_task_register`/`_delete` and `browser_attach` are ask-gated (design doc's explicit list: scheduler registration, existing-Chrome attach). Empirically verified this session: a non-interactive `opencode run` auto-REJECTS any ask-gated tool call, so unattended paths (scheduled tasks) can't silently escalate past this. **Remote Control (Phase 8, not yet implemented) is exactly this category's next item** — deliberately deferred to its own START per commander's direction, since it's the one boundary that doesn't exist yet at all. |

**Net assessment:** five of six boundaries have real, tested enforcement today (filesystem,
process, credentials, browser profile mostly solid; network and external-communication
partial by design — a browser tool's whole job is to browse). The one boundary with no
implementation at all is Remote Control's inbound network surface, which is Phase 8's
separate, not-yet-started item.

**OS/process/container/VM-level boundaries** (stronger than Tool-level checks) were compared
above (Background Desktop table) and not built — the current Tool-level checks address the
actual gaps found through this project's own security reviews; a VM/container boundary would
harden against a fundamentally different threat (a compromised or malicious MCP server
process itself, not a misused-but-honest one) which is out of scope for what's been asked.
