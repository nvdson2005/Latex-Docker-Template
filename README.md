# LaTeX Template

Docker-based LaTeX project, editable with the VS Code LaTeX Workshop extension.

## Layout

- `main.tex` – entry point (title, `\input` of sections)
- `preamble.tex` – packages and global settings
- `sections/` – content files
- `build/` – build output (git-ignored)
- `export/` – dated PDF copies (git-ignored)

## Use

1. Copy this folder, rename it, run `git init`.
2. **VS Code:** install *LaTeX Workshop*; the PDF builds in Docker on save into `build/`
   (settings in `.vscode/settings.json`).
3. **CLI:** `./build.sh [export-name]` builds via `docker compose` and copies
   `build/main.pdf` to `export/<name>-YY-MM-DD.pdf`.

Requires Docker. To rename the entry file, update `compose.yaml` and `build.sh`.

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

To use this template for Vietnamese text, switch the engine to XeLaTeX (`-xelatex` in
`compose.yaml` and the LaTeX Workshop recipe) as shared-reports does.
