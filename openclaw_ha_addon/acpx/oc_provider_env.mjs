// Shared helper for ACPX harness wrappers. Resolves the provider environment
// (Anthropic, OpenAI, Ollama) based on the add-on option ollama_base_url.
//
// Rules:
//   - If a real API key (ANTHROPIC_API_KEY / OPENAI_API_KEY) is set in the
//     environment, it is used as-is and the corresponding base URL is left
//     untouched (falls back to the upstream Anthropic / OpenAI API).
//   - Otherwise, the wrapper points the provider at OLLAMA_BASE_URL (default
//     http://localhost:11434) and uses 'ollama' as a placeholder token.
//   - OLLAMA_HOST is always set so opencode (and direct Ollama-aware tools)
//     can find the configured server.

const OLLAMA_DEFAULT = "http://localhost:11434";

export function resolveProviderEnv(processEnv) {
    const ollamaBaseUrl = processEnv.OLLAMA_BASE_URL || OLLAMA_DEFAULT;
    const out = { ...processEnv };

    // Anthropic / Claude Code
    if (!out.ANTHROPIC_API_KEY) {
        out.ANTHROPIC_BASE_URL = ollamaBaseUrl;
        out.ANTHROPIC_AUTH_TOKEN = "ollama";
    }

    // OpenAI / Codex
    if (!out.OPENAI_API_KEY) {
        out.OPENAI_BASE_URL = ollamaBaseUrl.replace(/\/+$/, "") + "/v1";
        out.OPENAI_API_KEY = "ollama";
    }

    // OpenCode / generic Ollama clients
    out.OLLAMA_HOST = ollamaBaseUrl;

    return out;
}
