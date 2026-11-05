# Notices

This plugin bundles a modified derivative of third-party open-source code.
The notices below are required by the respective licenses.

## Codex CLI — base_instructions prompt

| Field | Value |
| --- | --- |
| Project | OpenAI Codex CLI |
| Source | https://github.com/openai/codex |
| Upstream file | `codex-rs/protocol/src/openai_models.rs` (ModelInfo field `base_instructions`) |
| License | Apache License, Version 2.0 |
| License text | https://www.apache.org/licenses/LICENSE-2.0 |
| Bundled file | `src/fixtures/codex-base-instructions.txt` |

The bundled file is a modified derivative of the upstream `base_instructions`
prompt:

1. The opening line was replaced with a model placeholder so the prompt names
   the operator-configured model instead of a fixed upstream model.
2. An attribution header was prepended; the plugin removes it again before the
   prompt is handed to Codex.
3. The remaining lines are byte-identical to the upstream text.

The Apache License, Version 2.0 requires that modified files carry prominent
notices stating that they were changed. The bundled file carries such a notice
in its first lines.

## Other bundled code

No other third-party source code is vendored in this plugin. Runtime
dependencies are declared in `package.json` and keep their own licenses.
