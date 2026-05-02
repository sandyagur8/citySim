"""Interaction layer: agent-to-agent dialogue, persona-conditioned.

Two agents — typically a buyer and a seller — alternate turns through the
LLM gateway's ``agent`` tier (local Llama by default). After the dialogue
ends, an ``audit``-tier extraction call (OpenAI by default) parses the
transcript into a structured outcome record, which is appended to the
event log.
"""

from .runner import (
    DialogueResult,
    DialogueTurn,
    find_employee,
    pick_random_buyer,
    pick_random_store,
    run_dialogue,
)

__all__ = [
    "DialogueResult",
    "DialogueTurn",
    "find_employee",
    "pick_random_buyer",
    "pick_random_store",
    "run_dialogue",
]
