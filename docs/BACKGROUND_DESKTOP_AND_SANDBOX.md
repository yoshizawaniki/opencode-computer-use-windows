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

**This machine's actual edition, measured (not assumed):** `Get-CimInstance
Win32_OperatingSystem` reports **Windows 11 Home** (`EditionID = Core`). This matters because
Home lacks the RDP host, Hyper-V, and Windows Sandbox that Pro/Enterprise ship with — the
options below are evaluated against what THIS machine can actually run, not a generic
Windows install.

| Option | Isolation | Available on this machine (Home)? | Verdict |
|---|---|---|---|
| **Separate Windows session** (RDP-into-self, or a second local session) | Real: own desktop, own foreground/z-order, own window list. Same OS instance, same filesystem/registry/network. | **No.** Windows Home has no RDP host (`mstsc` can connect OUT, not accept inbound). Fast User Switching exists on Home, but only one session is interactively rendered at a time — the switched-away session's desktop isn't drawn, so UI Automation/SendInput against it doesn't behave like a real background desktop (elements report off-screen/inaccessible). Does not solve the problem on this edition. |
| **Windows Sandbox** (`WindowsSandbox.exe`) | Strong: disposable, isolated OS instance, own kernel-level namespace, resets on close. | **No.** Requires Pro/Enterprise/Education. |
| **VM** (Hyper-V, VirtualBox, VMware Player) | Strongest: fully separate OS, separate everything. | **Partial.** Hyper-V requires Pro+. VirtualBox/VMware Player run on Home, but need a separately-licensed Windows guest (or a Linux guest, which can't run this Windows-specific UIA/SendInput stack) — real cost and setup, not free. | Only path to genuine desktop isolation on THIS edition, and only after acquiring a guest OS license. |
| **Stay on the shared desktop, rely on existing Tool-level guards** | None (shared desktop, real contention as measured). | Already true today, zero cost. | **Recommended default for this machine.** See below. |

**Recommendation, revised for what this machine can actually run: stay on the shared
desktop.** None of the isolation options are free on Windows 11 Home — the two OS-native ones
(separate session, Windows Sandbox) are simply unavailable, and the remaining option (a VM)
requires a paid second Windows license to be useful for this Windows-specific tool stack. The
desktop-contention problem this session measured (a real window occluding a target pixel) is
real but occasional and already visible to the caller — `desktop_annotate_point`/`desktop_click`
fail loudly (refused, not silently wrong) when it happens, which is the acceptable mitigation
at zero cost. **If the user upgrades to Windows 11 Pro**, re-evaluate: a second local session
(free, built into Pro) becomes the right default — it solves the desktop-contention problem
with existing OS mechanisms and no provisioning. Windows Sandbox remains worth a look later
for a genuinely disposable, no-persistent-
state execution mode (e.g. running an untrusted workflow file from Record & Replay) — a
different requirement than desktop contention, not pursued now (YAGNI: no current caller
needs it, and it's unavailable on this edition anyway).

Not implemented in this pass — this is operator guidance (what to do IF the edition changes),
not something `server.js` itself can arrange; it doesn't control which session/edition it
runs under.

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

**Known coordinate-system risk (not fixed, documented):** `src/uia.ps1` declares no DPI
awareness. At this machine's current 100% display scaling, UIA physical coordinates and
WinForms' `VirtualScreen`/`SendInput` coordinates agree, which is why the screenshot-origin
fix above (see F1 FINAL) works cleanly. At a non-100% scale factor, UIA and WinForms can
report different coordinate spaces for the same physical pixel — not exercised or fixed here.

**OS/process/container/VM-level boundaries** (stronger than Tool-level checks) were compared
above (Background Desktop table) and not built — the current Tool-level checks address the
actual gaps found through this project's own security reviews; a VM/container boundary would
harden against a fundamentally different threat (a compromised or malicious MCP server
process itself, not a misused-but-honest one) which is out of scope for what's been asked.
