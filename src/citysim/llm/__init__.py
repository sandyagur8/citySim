"""LLM gateway: a thin, provider-agnostic chat interface with tiered routing.

The simulator never talks to a model SDK directly — it goes through this
gateway. The gateway routes by *tier*:

* ``agent``  → local Ollama (Llama 3.1 8B by default). All agent dialogue,
               persona-conditioned roleplay, and routine responses run here.
* ``audit``  → OpenAI (gpt-4o-mini by default). The 1-5% sampled tier used
               for ground-truth dialogue audits and structured outcome
               extraction. Override with ``OPENAI_MODEL`` for higher tiers.

Use ``get_gateway(tier="agent")`` from anywhere in the code. The function
caches one gateway per tier so repeated calls are free.
"""

from .gateway import (
    LLMGateway,
    LLMMessage,
    LLMResponse,
    get_default_gateway,
    get_gateway,
)

__all__ = [
    "LLMGateway",
    "LLMMessage",
    "LLMResponse",
    "get_default_gateway",
    "get_gateway",
]
