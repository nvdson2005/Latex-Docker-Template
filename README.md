# LaTeX Template

Docker-based LaTeX project with a local browser editor, PDF preview, and VS Code LaTeX Workshop support.

## Layout

- `main.tex` – entry point (title, `\input` of sections)
- `preamble.tex` – packages and global settings
- `sections/` – content files
- `build/` – build output (git-ignored)
- `export/` – dated PDF copies (git-ignored)

## Browser editor

From the project directory, run:

```sh
docker compose up
```

Open [http://localhost:3000](http://localhost:3000). Docker publishes the editor on the local loopback interface. The first build downloads dependencies. The built image can start offline with `docker compose up --no-build`.

- Open files from the project tree. Use **New file**, **New folder**, **Rename**, and **Delete** to manage entries. Enter project-relative paths when creating or moving files. You can edit `.tex`, `.bib`, `.sty`, and `.cls` sources and manage assets such as images from the tree.
- Use **Save**, Ctrl+S, or Cmd+S to write the active file. Drafts stay in the browser when you switch files. If a file changed on disk, review the disk copy and choose **Reload disk copy** or **Retry save**.
- Use **Compile** to build the saved files from `main.tex`. **Auto-compile** is off by default. When enabled, it starts a build about 1.5 seconds after the latest successful save.
- Open **Compile log** for diagnostics and select a linked error to jump to its source. The preview and **Download PDF** keep using the last successful build after a compile error.

Browser build files live in `build/browser/work/`. The downloadable snapshot is `build/browser/last-good.pdf`.

## VS Code and command line

- In VS Code, install **LaTeX Workshop**. Saving runs the Docker recipe configured in `.vscode/settings.json` and writes `build/main.pdf`.
- Run `./build.sh [export-name]` to build through the legacy Compose service and copy `build/main.pdf` to `export/<name>-YY-MM-DD.pdf`. The default name is `Document`.

## Related: shared-reports

This is the single-document starter. Multi-document repo
[`shared-reports`](../../Uni/SpecializedProject/shared-reports/README.md)
(`~/Uni/SpecializedProject/shared-reports`) holds several standalone LaTeX projects under
`projects/<name>/` and scaffolds new ones from its own `templates/report/` via `make new P=<name>`.

| | this template | shared-reports |
|---|---|---|
| Layout | one project at repo root | one project per `projects/<name>/` |
| Build | `./build.sh`, `docker compose` | `make pdf P=<name>`, own Docker image |
| Engine | `latexmk -pdf` (pdfLaTeX) | XeLaTeX (needed for Vietnamese) |
| Overleaf | not set up | zip project folder, set compiler to XeLaTeX |

Shared conventions: entry point is `main.tex`, keep paths relative to the project folder
(Docker and LaTeX Workshop mount only that folder), build output goes to git-ignored `build/`.

For the CLI and VS Code workflows, you can switch to XeLaTeX (`-xelatex` in the
Compose build command and the LaTeX Workshop recipe) as shared-reports does. The browser
compiler uses pdfLaTeX.

### LaTeX completion in the browser editor

The editor image includes TexLab. Type a command such as `\sec` or start
`\begin{ite` to see suggestions. Use Ctrl+Space to request suggestions,
the arrow keys to select one, and Enter to insert it. Reference completion
can use labels from other project files, including unsaved browser buffers.

Completion runs locally and works offline after the image is built. If TexLab
restarts, the browser reconnects and resends its open drafts. You can keep
editing and saving during the reconnect. Compile and PDF preview use saved
files.
