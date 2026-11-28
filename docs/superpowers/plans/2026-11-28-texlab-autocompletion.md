# TexLab Autocompletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal.** Provide project-aware LaTeX completion in the existing CodeMirror popup, including references to unsaved edits in another file.

**Architecture.** A pinned TexLab binary runs in the editor container. Each browser connection gets its own TexLab process and document overlays via a same-origin Fastify WebSocket bridged to TexLab's stdio. CodeMirror's LSP client supplies completion, and the existing workspace buffer map owns the text sent to the server.

**Tech stack.** TexLab, LSP over JSON-RPC, Fastify 5, Node 22, CodeMirror 6, Vite, Docker Compose, and Vitest.

**Baseline.** [Local LaTeX editor design](../specs/2026-11-27-local-latex-editor-design.md). This plan records the agreed TexLab approach. Hover, definition navigation, diagnostics UI, and custom snippets can be evaluated separately.

## Global constraints

- Keep the one-command launch, loopback publication at `127.0.0.1:3000`, and offline operation once built.
- Use the configured project root, `/data` under Compose. The existing compiler owns saved-file builds of `main.tex` and PDF publication. Set TexLab build-on-save off and disable forward search and external linting.
- Workspace buffer text is authoritative for open documents. Sending it to TexLab is independent of saving or compiling.
- Keep highlighting and editing usable when the language server is unavailable.

## File map

- `editor/Dockerfile` packages TexLab. `editor/server/app.ts` registers the socket and shares project validation with the file API.
- `editor/server/lsp-routes.ts` owns the socket, protocol checks, stdio framing, and child lifecycle. `editor/server/project-files.ts` exposes a validated source location if the current API lacks one.
- `editor/client/latex-completion.ts` owns transport, LSP completion, URI construction, and document synchronization. `editor/client/workspace.ts` supplies buffer lifecycle events. Both dependency changes update `editor/package.json` and its lockfile.
- `editor/test/lsp-routes.test.ts` exercises the bridge with a fake subprocess. `editor/test/workspace.test.ts` covers buffer lifecycle and regressions. `README.md` documents use and offline verification.

## Review focus

- Unsaved labels survive a file switch and a reconnect.
- Folder moves, deletes, and external saves update the server's view without undoing local edits.
- LaTeX prefixes and replacement ranges work with leading backslashes, existing braces, and Unicode before the cursor.
- Browser tabs have independent unsaved text. Foreign origins cannot start a language server.
- A child crash during typing leaves the buffer editable and the next successful session receives current text.

### Task 1 — Package TexLab and expose a scoped transport

- [ ] Add bridge tests. Assert a matching loopback Host and Origin can connect to `GET /api/lsp`. Reject foreign or absent Origin before spawning. Reject a document URI outside the root, reserved sources, and symlink traversal. Assert arbitrary build and command requests never reach the subprocess.
- [ ] Add framing and lifecycle tests. Deliver one UTF-8 message in fragments and two frames in a single write. Assert one complete JSON message per WebSocket frame, correct byte lengths in both directions, independent processes for two sockets, and child cleanup on disconnect, shutdown, or process failure.
- [ ] From `editor`, run `npx vitest run test/lsp-routes.test.ts` and confirm the new coverage fails before wiring.
- [ ] Implement `registerLspRoutes(app, projectRoot, projectFiles)` using a Fastify-compatible WebSocket plugin. Spawn TexLab lazily with fixed arguments and the configured root. Reuse the project file policy for document URIs and enforce initialization against the canonical project root. Permit initialization, document lifecycle, completion and cancellation, plus only the configuration and file notifications required by the pinned pair. Bound message sizes and queued writes and release the child on either side closing. Use a deterministic fake child in route tests.
- [ ] Pin a TexLab release and verify checksums for the supported Docker architectures. Install in the runtime stage and verify with `docker compose build app` and `docker compose run --rm --no-deps app texlab --version`. Run the bridge tests and `npm run build` from `editor`. Record the selected version and platform verification in the implementation change.

### Task 2 — Connect completion to the workspace buffers

- [ ] Test that a dirty buffer remains open in the LSP session when the editor switches files. Assert changes precede the completion request, a reconnect opens each current buffer once with its latest text, and late results from an old connection or file do not appear. Cover a folder move, deletion, and clean disk refresh alongside a dirty-buffer conflict.
- [ ] From `editor`, run `npx vitest run test/workspace.test.ts` and confirm the new assertions fail before integration.
- [ ] Add the official `@codemirror/lsp-client`. Verify the pinned client's workspace hooks can keep non-visible documents open before wiring the editor. Use one workspace and one synchronization owner per connection. If the installed client binds document lifetime to the visible view, use its workspace facilities where supported or adapt its completion integration without emitting duplicate document lifecycle notifications.
- [ ] In `latex-completion.ts`, expose a workspace-scoped session with `extensionFor(path)`, `upsert(path, text)`, `close(path)`, and `dispose()`. Use the server-confirmed workspace root for encoded file URIs. Reuse the client's negotiated position encoding and completion edit handling. Use monotonic document versions within a connection. Replay current snapshots after initialization on reconnect. Forward relevant on-disk file changes only after the file API succeeds or refresh observes them.
- [ ] In `workspace.ts`, wire open, edits, clean refresh, confirmed reload, move, delete, and teardown into that session. Keep inactive buffers registered and move document state from old URIs to new URIs after successful renames. Enable the CodeMirror completion extension only for an active source buffer. Use LaTeX-aware triggering and verify that ordinary prose stays quiet and explicit completion remains available.
- [ ] Run the workspace tests and `npm run build` from `editor`. Verify a simulated disconnect does not block editing or saving.

### Task 3 — Verify the real browser and container flow

- [ ] Run `docker compose up --build -d app`. In the browser, verify automatic and explicit completion for a command and environment. Confirm selection respects the replacement range when braces already exist and when the cursor follows Unicode text.
- [ ] Add an unsaved label to an included section, switch to `main.tex`, and verify that typing `\ref{sec:` offers it. Repeat after a WebSocket disconnect and reconnect. Check a citation from a referenced bibliography if the fixture includes one. Open a second tab and verify the first tab's unsaved label does not appear there. Restore fixture edits after verification.
- [ ] Stop TexLab during editing and verify that editing and saving still work. Reconnect and verify completion resumes. Compile using the existing control and verify the saved-files PDF updates. Repeat completion with the built image and network access unavailable.
- [ ] Document the completion trigger, keyboard invocation, packaged TexLab, and behavior when the server is unavailable. Run `npm test` and `npm run build` from `editor` and record container/browser results. Keep task commits scoped to their respective changes.

## Execution results

- Built and started the Compose app on arm64 with TexLab 5.26.0. The Dockerfile also pins the upstream amd64 checksum. The amd64 image was not run.
- Passed all 37 Vitest tests and the TypeScript and Vite build.
- In the browser, verified automatic command and environment completion, explicit completion, replacement with existing braces and a Unicode prefix, an unsaved cross-file label, WebSocket reconnect, and isolation between tabs. The Compile control produced a rendered PDF.
- The network-disabled container probe did not confirm completion. Browser verification used a WebSocket disconnect for recovery, and the bridge tests simulated a child exit. A real process crash during saving and bibliography completion were not exercised in the browser.
