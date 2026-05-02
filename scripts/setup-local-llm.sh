#!/usr/bin/env bash
# Sim-city local LLM setup.
#
# Installs Ollama, pulls an 8B-class Instruct model, and tells you how to
# point the simulator's gateway at it. All agent-to-agent dialogue runs on
# this local model — no per-token cost, and it stays on your machine.
#
# Defaults to llama3.1:8b (about 4.7 GB on disk). Pass a different model
# tag as the first argument if you'd rather use Qwen, Mistral, etc.
#
# Usage:
#   bash scripts/setup-local-llm.sh                 # llama3.1:8b
#   bash scripts/setup-local-llm.sh qwen2.5:7b      # Qwen alternative
#   bash scripts/setup-local-llm.sh llama3.1:8b-instruct-q4_K_M  # smaller quant

set -euo pipefail

MODEL="${1:-llama3.1:8b}"
OLLAMA_URL="http://localhost:11434"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

bold "Sim-city local LLM setup"
echo

# ---------------------------------------------------------------------------
# 1. Install Ollama if missing
# ---------------------------------------------------------------------------
if command -v ollama >/dev/null 2>&1; then
  ok "Ollama already installed ($(ollama --version 2>&1 | head -n1))"
else
  bold "Installing Ollama..."
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install ollama
      else
        warn "Homebrew not found — falling back to the official installer."
        curl -fsSL https://ollama.com/install.sh | sh
      fi
      ;;
    Linux)
      curl -fsSL https://ollama.com/install.sh | sh
      ;;
    *)
      warn "Unsupported OS. Visit https://ollama.com/download and install manually."
      exit 1
      ;;
  esac
  ok "Ollama installed."
fi

# ---------------------------------------------------------------------------
# 2. Make sure the daemon is running
# ---------------------------------------------------------------------------
if curl -fsS "${OLLAMA_URL}/api/version" >/dev/null 2>&1; then
  ok "Ollama daemon already running at ${OLLAMA_URL}"
else
  bold "Starting Ollama daemon (background)..."
  # macOS: `brew services start ollama` (preferred); Linux: nohup
  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    brew services start ollama >/dev/null 2>&1 || true
  fi
  if ! curl -fsS "${OLLAMA_URL}/api/version" >/dev/null 2>&1; then
    nohup ollama serve >/tmp/ollama.log 2>&1 &
    sleep 3
  fi
  for _ in 1 2 3 4 5; do
    if curl -fsS "${OLLAMA_URL}/api/version" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if ! curl -fsS "${OLLAMA_URL}/api/version" >/dev/null 2>&1; then
    warn "Daemon didn't come up. Try \`ollama serve\` in another terminal and re-run."
    exit 1
  fi
  ok "Ollama daemon up."
fi

# ---------------------------------------------------------------------------
# 3. Pull the model
# ---------------------------------------------------------------------------
bold "Pulling ${MODEL} (first run downloads ~4–5 GB)..."
ollama pull "${MODEL}"
ok "Model ${MODEL} ready."

# ---------------------------------------------------------------------------
# 4. Quick smoke test against the OpenAI-compatible endpoint
# ---------------------------------------------------------------------------
bold "Smoke test — calling the OpenAI-compatible /v1/chat/completions endpoint..."
REPLY=$(curl -fsS "${OLLAMA_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Say hi in five words.\"}],
    \"max_tokens\": 32
  }" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["choices"][0]["message"]["content"].strip())' || echo "<no reply>")
ok "Reply: ${REPLY}"

# ---------------------------------------------------------------------------
# 5. Tell the user how to wire it up
# ---------------------------------------------------------------------------
echo
bold "All set. To use this from Sim-city:"
info "export OLLAMA_MODEL=${MODEL}"
info "export OLLAMA_BASE_URL=${OLLAMA_URL}/v1"
info "citysim llm-test --tier agent       # routes to local Ollama"
info "citysim llm-test --tier audit       # routes to OpenAI (needs OPENAI_API_KEY)"
echo
info "The simulator's 'agent' tier defaults to Ollama — every agent dialogue"
info "in the interaction runner will go through this local model."
