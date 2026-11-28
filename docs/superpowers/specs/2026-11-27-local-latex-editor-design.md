# Local LaTeX editor design

## Goal and scope

Bundle a daily-use browser editor with this LaTeX template. Run `docker compose up` from the repository root and open `http://localhost:3000` to edit the project and preview `main.tex`. The project remains a folder on disk that Git and VS Code can use directly. The app runs without internet access once its image is built.

The first release includes file and folder management, unsaved edits per file, manual and optional automatic compilation, a compiler log with linked errors, and a PDF preview with scroll and zoom retention. Collaboration, accounts, version history, multi-project management, LAN access, SyncTeX, and entry point or engine selection are outside this release.

## Approaches

- **Bundled editor (selected).** Include the editor and its Compose service in the template. Each copy opens its own project root with the existing build conventions. Updates to the editor travel with the template or its copies.
- **Standalone editor.** Install once and point it at one mounted project at a time. This centralizes updates and adds a mount-path setup step and project compatibility decisions.

Bundling matches the one-command launch and the fixed `main.tex` entry point. Use Fastify and Node 22 in the TeX Live image, with a Vite-built vanilla TypeScript frontend, CodeMirror 6 with LaTeX highlighting, and a locally bundled PDF.js worker. Serve the UI, API, event stream, and PDF from one origin.

## Editor and file operations

The workspace has a collapsible project tree and a horizontally resizable split between the editor and the PDF. The toolbar exposes save, compile, automatic compile, and download. Compile status and the log are available alongside the editor. Clicking a diagnostic opens the matching file and line when the compiler provides both.

The tree lists project directories, editable LaTeX sources such as `.tex`, `.bib`, `.sty`, and `.cls`, and document assets such as images and PDFs. Text sources open in the editor and binary assets are listed with file-management actions. Exclude hidden metadata, app implementation files, and generated or exported outputs at the API boundary and in the tree. Tree controls create files and folders, rename or move them within the project, and confirm deletion. Creating or renaming onto an existing path fails without replacing it. A rename carries open buffers to their new paths. Deleting a file or folder with unsaved buffers warns that those edits will be discarded and clears the affected buffers only after deletion succeeds.

Switching files retains unsaved buffers in browser memory. `Ctrl/Cmd+S` saves the active file. Warn before leaving the page while edits are unsaved. Saves include the disk revision the buffer was based on. If VS Code or another process has changed the file, keep the browser buffer and offer to reload the disk copy or explicitly save over the displayed revision. Refresh clean open files and the tree when the tab regains focus. File operations report errors without clearing unsaved work.

## Compilation and preview

Compile the saved files with pdfLaTeX through `latexmk`, using `main.tex`, noninteractive mode, file-and-line diagnostics, and shell escape disabled. Disable project and user `latexmk` startup files for browser builds. Use a persistent browser-only working output directory under `build/` so incremental runs can reuse artifacts and the existing CLI and VS Code output paths remain available.

Allow one browser compile at a time and coalesce requests that arrive during it into one pending run. After 60 seconds, terminate the compiler and its subprocesses before starting the pending run. Manual Compile uses saved files and indicates when unsaved edits are excluded. Automatic compile is off by default. When enabled, it runs roughly 1.5 seconds after the last successful browser save. Typing alone keeps changes in memory, and external saves are picked up the next time the browser compiles.

The compile endpoint acknowledges the request immediately. Server-Sent Events deliver state and log updates. Initial connection and reconnection receive the current state, available log, and last successful PDF revision. The UI shows idle, compiling, success, and error. Unlinked compiler output stays readable even when a diagnostic lacks a project file or line.

After a successful compile, publish the resulting PDF atomically as the last good browser PDF. Keep that snapshot across subsequent compile errors and container restarts. The preview and download use the published snapshot, keyed by revision so the browser fetches fresh bytes after publication. PDF.js preserves zoom and the visible page and offset where possible, clamping to the remaining pages if the document shrinks. Keep the old view on screen until the new PDF can be displayed. A fresh project without a published PDF shows a prompt to compile.

## Local runtime and file boundary

The default Compose service is the editor, with a port published only at `127.0.0.1:3000`. Retain the explicitly invoked `latex` service for `./build.sh` and keep its existing output path. Bundle dependencies, fonts used by the interface, and browser assets into the image. Run the editor and compiler as the host project owner, with a Compose configuration that works without exported `UID` or `GID` variables in ordinary local checkouts. Verify browser-created files and build artifacts can be edited and removed by the host user.

Validate request hosts for loopback access and restrict browser mutations to the app's own origin, including compile requests. Filesystem endpoints share a single project-path policy for listing, reading, creating, saving, renaming, and deleting. Reject absolute paths, traversal, reserved paths, and symlink traversal. Apply the same policy to both sides of a move and to paths used for diagnostic navigation. The compiler uses a fixed entry point and fixed arguments supplied by the server. The Compose service requires no Docker socket mount.

## Acceptance

- An ordinary checkout can start the editor with `docker compose up`, load it at `http://localhost:3000`, and use it offline with the image already built. The service is unreachable from the LAN.
- Create, rename, and delete files and folders from the tree. Verify deletion confirmation, per-file dirty state after switching files, keyboard save, and conflict handling when an open file changes on disk.
- Edit and save `sections/example.tex`, then compile and download the updated PDF. Verify a representative incremental compile completes within five seconds on the template under normal local conditions.
- Enable auto-compile and make several saves in quick succession. Verify the debounce, a single active compile, one pending compile under load, and recovery after a timeout.
- Introduce a LaTeX syntax error. Verify status and log output, navigation to a diagnostic with a file and line, and continued access to the last successful PDF. Fix the source and verify that PDF refresh preserves the current zoom and position.
- Verify invalid and reserved paths fail for reads and writes, including traversal through a symlink and through either side of a move. Verify a cross-origin browser mutation fails and compile runs with shell escape disabled.
- Run `./build.sh` while the app is up and verify it still exports a dated PDF. Verify the VS Code recipe still produces its PDF in `build/` and that browser build outputs stay separate.

## Implementation decisions

The implementation plan owns API route names and payload schemas, upload support is outside the first release, and visual styling follows the existing functional layout. Specific implementation choices for process termination, revision tracking, atomic writes, and container user mapping must satisfy the behavior described above.
