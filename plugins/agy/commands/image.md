---
description: Generate an image with Antigravity CLI (uses agy's built-in generate_image tool — Imagen under the hood)
argument-hint: "[--name <slug>] [--output <path>] <description>"
allowed-tools: Bash(bash:*)
---

Ask `agy` to generate an image. The Antigravity CLI ships a native
`generate_image` tool (Imagen) that triggers automatically when the prompt
asks for an image — the wrapper builds the right prompt and can copy the
generated file into your working directory.

The user's request (treat as opaque — pass through as shell-safe
arguments):

```
$ARGUMENTS
```

## How to invoke

Parse the user's request into three parts:

- `--name <slug>` — optional. Filename slug `agy` should save the image
  under (no extension).
- `--output <path>` — optional. Local path the wrapper should copy the
  generated file to after `agy` finishes.
- The remaining text — the description of what to generate.

Use the `Bash` tool to run:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/agy-run.sh" image "<description>" [--name <slug>] [--output <path>]
```

…with the description quoted as one shell argument so characters like `"`,
`$`, `;` cannot break out.

## Notes

- `agy` writes generated images to its artifacts directory (e.g.
  `~/.gemini/antigravity-cli/brain/<uuid>/<name>.png`). Pass `--output` if
  you want the file copied next to your project.
- Return Antigravity's full text response verbatim so the user can see the
  generated path.
- If the user did not provide any description, ask what they want to
  generate.
- If the wrapper reports `agy is not installed` or `not authenticated`,
  stop and tell the user to run `/agy:setup`.
