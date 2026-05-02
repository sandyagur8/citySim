"""Provider-agnostic LLM gateway.

The simulator calls `gateway.chat(...)` and gets back text. Providers are
selected by env var (`CITYSIM_LLM_PROVIDER`, default `openai`) and configured
through provider-specific env vars:

  openai:
    OPENAI_API_KEY            (required)
    OPENAI_MODEL              (default: gpt-4o-mini)
    OPENAI_BASE_URL           (optional — for Azure / proxies / Ollama-OpenAI)

  ollama-openai:
    OLLAMA_BASE_URL           (default: http://localhost:11434/v1)
    CITYSIM_OLLAMA_MODEL      (default: tinyllama)
    OLLAMA_MODEL              (legacy fallback)

We intentionally keep the surface small: list of role/content messages in,
text out, plus an optional structured-JSON helper. Persona generation and the
interaction runner both call this same `chat()`.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

import httpx


Role = Literal["system", "user", "assistant"]


@dataclass
class LLMMessage:
    role: Role
    content: str


@dataclass
class LLMResponse:
    text: str
    model: str
    usage: dict[str, int] | None = None


class LLMGateway:
    """Single entry point for all model calls.

    Holds the provider configuration so callers don't think about which
    backend is live. Designed to be cheap to instantiate (no eager network
    calls) so tests can build a gateway pointing at a fake server.
    """

    def __init__(
        self,
        provider: str = "openai",
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
        timeout_s: float = 60.0,
    ) -> None:
        self.provider = provider.lower().strip()
        self.timeout_s = timeout_s

        if self.provider == "openai":
            self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
            if not self.api_key:
                raise RuntimeError(
                    "OpenAI provider selected but OPENAI_API_KEY is not set. "
                    "Export it in your shell or pass api_key=... explicitly."
                )
            self.model = model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
            self.base_url = (
                base_url or os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1"
            ).rstrip("/")
        elif self.provider == "ollama-openai":
            # Ollama exposes an OpenAI-compatible endpoint at /v1/chat/completions.
            # No API key needed for a local Ollama install.
            self.api_key = api_key or os.environ.get("OPENAI_API_KEY") or "ollama"
            self.model = (
                model
                or os.environ.get("CITYSIM_OLLAMA_MODEL")
                or os.environ.get("OLLAMA_MODEL")
                or "tinyllama"
            )
            self.base_url = (
                base_url or os.environ.get("OLLAMA_BASE_URL") or "http://localhost:11434/v1"
            ).rstrip("/")
        else:
            raise ValueError(
                f"Unknown LLM provider {self.provider!r}. Supported: 'openai', 'ollama-openai'."
            )

    # ------------------------------------------------------------------
    # Synchronous chat
    # ------------------------------------------------------------------

    def chat(
        self,
        messages: Iterable[LLMMessage] | Iterable[dict[str, str]],
        *,
        temperature: float = 0.7,
        max_tokens: int | None = 512,
        response_format: dict[str, Any] | None = None,
    ) -> LLMResponse:
        """Run a chat completion. Returns the assistant's reply as text.

        `response_format={"type": "json_object"}` requests structured JSON
        output (OpenAI-compatible). Use `chat_json` for the parsed-dict
        convenience wrapper.
        """
        url = f"{self.base_url}/chat/completions"
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [_normalize_msg(m) for m in messages],
            "temperature": temperature,
        }
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if response_format is not None:
            body["response_format"] = response_format

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

        with httpx.Client(timeout=self.timeout_s) as client:
            resp = client.post(url, json=body, headers=headers)

        if resp.status_code != 200:
            raise RuntimeError(
                f"LLM gateway ({self.provider}) HTTP {resp.status_code}: {resp.text[:400]}"
            )

        data = resp.json()
        choice = data["choices"][0]
        text = (choice.get("message") or {}).get("content") or ""
        return LLMResponse(
            text=text,
            model=data.get("model", self.model),
            usage=data.get("usage"),
        )

    def chat_json(
        self,
        messages: Iterable[LLMMessage] | Iterable[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int | None = 512,
    ) -> dict[str, Any]:
        """Chat completion that returns a parsed JSON object.

        Lower default temperature, response_format pinned to json_object.
        Raises ValueError if the model emits non-JSON.
        """
        resp = self.chat(
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
        try:
            parsed: dict[str, Any] = json.loads(resp.text)
            return parsed
        except json.JSONDecodeError as e:
            raise ValueError(f"LLM returned non-JSON content: {resp.text[:200]!r}") from e


def _normalize_msg(m: LLMMessage | dict[str, str]) -> dict[str, str]:
    if isinstance(m, LLMMessage):
        return {"role": m.role, "content": m.content}
    return {"role": m["role"], "content": m["content"]}


# ---------------------------------------------------------------------------
# Tier routing — agent vs audit
# ---------------------------------------------------------------------------
#
# The design doc separates traffic into tiers (§11). At Phase 0 the policy is:
#
#   agent  → local Ollama (no per-token cost; small model is fine for
#            persona-conditioned dialogue and short-form responses)
#   audit  → OpenAI (better quality for the 1-5% audit slice and for
#            structured outcome extraction with response_format=json_object)
#
# Both are overridable by env vars so a user can flip "agent" to OpenAI
# while running on a laptop without Ollama, or flip "audit" to Anthropic
# later when we add a third client class.

_TIER_DEFAULTS: dict[str, str] = {
    "agent": "ollama-openai",
    "audit": "openai",
}


def _provider_for_tier(tier: str) -> str:
    env_key = f"CITYSIM_LLM_PROVIDER_{tier.upper()}"
    return os.environ.get(env_key) or _TIER_DEFAULTS.get(tier, "openai")


_gateways: dict[str, LLMGateway] = {}


def get_gateway(
    tier: str = "agent",
    *,
    provider_override: str | None = None,
    model_override: str | None = None,
) -> LLMGateway:
    """Get (and cache) the gateway for the given tier.

    Tier ``agent`` is the default — all simulated agent dialogue should go
    through this. Tier ``audit`` is the OpenAI-backed slice used for
    higher-fidelity sampling and structured outcome extraction.
    """
    cache_key = f"{tier}:{provider_override or ''}:{model_override or ''}"
    if cache_key in _gateways:
        return _gateways[cache_key]
    provider = provider_override or _provider_for_tier(tier)
    gw = LLMGateway(provider=provider, model=model_override)
    _gateways[cache_key] = gw
    return gw


# Back-compat: existing callers still expect `get_default_gateway()`.
_default: LLMGateway | None = None


def get_default_gateway() -> LLMGateway:
    """Deprecated. Use ``get_gateway(tier=...)`` instead."""
    global _default
    if _default is None:
        provider = os.environ.get("CITYSIM_LLM_PROVIDER", "ollama-openai")
        _default = LLMGateway(provider=provider)
    return _default
