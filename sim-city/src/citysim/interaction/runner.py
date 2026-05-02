"""Run a buyer-seller dialogue end-to-end through the LLM gateway.

The runner alternates turns between two persona-conditioned chat threads
(buyer / seller), each using ``get_gateway(tier="agent")`` — which routes
to the local Llama by default. After the dialogue ends, an audit-tier
extraction call (``tier="audit"`` → OpenAI) parses the transcript into a
structured outcome record and the whole thing is appended to the event log.

If the audit gateway can't be initialised (no ``OPENAI_API_KEY``), we fall
back to a simple rule-based outcome so the simulator keeps running fully
locally. The transcript itself is unaffected.
"""

from __future__ import annotations

import random
import re
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
import logging

from citysim.llm import LLMMessage, get_gateway
from citysim.product import ProductBrief
from citysim.store import EventLog
from citysim.world.establishments import Establishment, EstablishmentKind
from citysim.world.personas import Persona

from .prompts import (
    EXTRACTION_PROMPT,
    PRODUCT_EXTRACTION_PROMPT,
    buyer_system_prompt,
    seller_system_prompt,
)
from .transport import LocalTransport, Transport

log = logging.getLogger("citysim.interaction.runner")
_CANNED_PREFIXES = (
    "absolutely",
    "of course",
    "certainly",
    "no problem",
    "sure thing",
    "here are",
)

# Establishments that make sense for a customer-facing buyer dialogue.
# Office / school / hospital / police are skipped — those are workplaces or
# institutional interactions, modelled separately.
SHOPPABLE_KINDS: set[EstablishmentKind] = {
    EstablishmentKind.SUPERMARKET,
    EstablishmentKind.COFFEE_SHOP,
    EstablishmentKind.RESTAURANT,
    EstablishmentKind.PUB,
    EstablishmentKind.HARDWARE,
    EstablishmentKind.PHARMACY,
    EstablishmentKind.CLOTHING,
    EstablishmentKind.BANK,
}


@dataclass
class DialogueTurn:
    speaker: str  # "buyer" | "seller"
    text: str


@dataclass
class DialogueResult:
    buyer_id: str
    seller_id: str
    establishment_id: str
    establishment_kind: str
    turns: list[DialogueTurn] = field(default_factory=list)
    end_reason: str = ""  # "buy" | "leave" | "max_turns"
    outcome: dict[str, Any] = field(default_factory=dict)
    duration_s: float = 0.0
    # Product testing metadata
    product_id: str | None = None  # name of the ProductBrief, if any
    dialogue_kind: str = "generic"  # "product" | "generic"
    arm: str = "random"  # "random" | "targeted" — A/B sampling arm
    targeted: bool = False  # whether buyer matched the product target filter
    # Correlation id (set by run_dialogue) so streaming events can be tied to one row.
    dialogue_id: str = ""


# ---------------------------------------------------------------------------
# Helpers — pick a buyer / a store / find an employee
# ---------------------------------------------------------------------------


def find_employee(est: Establishment, personas: list[Persona]) -> Persona | None:
    """Return any agent whose employer is this establishment, or None."""
    for p in personas:
        if p.employer_id == est.id:
            return p
    return None


def pick_random_buyer(personas: list[Persona], rng: random.Random | None = None) -> Persona:
    rng = rng or random.Random()
    adults = [p for p in personas if 18 <= p.age <= 75]
    return rng.choice(adults or personas)


def pick_random_store(
    establishments: list[Establishment],
    personas: list[Persona],
    rng: random.Random | None = None,
) -> tuple[Establishment, Persona] | None:
    """Pick a random shoppable establishment that has at least one employee."""
    rng = rng or random.Random()
    candidates = [e for e in establishments if e.kind in SHOPPABLE_KINDS]
    rng.shuffle(candidates)
    for est in candidates:
        emp = find_employee(est, personas)
        if emp is not None:
            return est, emp
    return None


# ---------------------------------------------------------------------------
# Main dialogue loop
# ---------------------------------------------------------------------------


def run_dialogue(
    buyer: Persona,
    seller: Persona,
    est: Establishment,
    *,
    max_turns: int = 8,
    extract_outcome: bool = True,
    log_to: EventLog | None = None,
    sim_minute: float = 0.0,
    day_of_year: int = 0,
    on_turn: Callable[[DialogueTurn], None] | None = None,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    product: ProductBrief | None = None,
    arm: str = "random",
    targeted: bool = False,
    transport: Transport | None = None,
    transport_required: bool = False,
) -> DialogueResult:
    """Run one buyer-seller dialogue. Returns the transcript + outcome.

    Pass ``on_turn(turn)`` to stream turns to a callback (e.g. for live
    printing in the CLI). If ``log_to`` is provided, the result is also
    appended to the event log under kind="dialogue".

    Pass ``on_event(payload)`` to stream structured live events. The runner
    fires three event types — all keyed by ``dialogue_id`` so a UI can
    correlate them:

    * ``dialogue_started``: includes buyer/seller/establishment/product info
    * ``dialogue_turn``: one per spoken turn (speaker + text)
    * ``dialogue_ended``: end_reason + extracted outcome + duration

    If ``product`` is provided AND its category matches ``est.kind``, the
    seller pitches that specific product, the buyer evaluates buying it,
    and the audit-tier extractor pulls richer fields (intrinsic motivator,
    winning phrase, objections, target fit). For non-matching shops the
    dialogue runs in "generic" mode — useful as a baseline.
    """
    t0 = time.monotonic()
    agent_gw = get_gateway(tier="agent")
    transport = transport or LocalTransport()

    is_product_dialogue = product is not None and product.category == est.kind.value
    active_product = product if is_product_dialogue else None

    buyer_sys = buyer_system_prompt(buyer, est, seller.occupation, active_product)
    seller_sys = seller_system_prompt(seller, est, active_product)

    buyer_history: list[LLMMessage] = [LLMMessage(role="system", content=buyer_sys)]
    seller_history: list[LLMMessage] = [LLMMessage(role="system", content=seller_sys)]

    dialogue_id = uuid.uuid4().hex[:12]
    result = DialogueResult(
        buyer_id=buyer.agent_id,
        seller_id=seller.agent_id,
        establishment_id=est.id,
        establishment_kind=est.kind.value,
        product_id=product.name if active_product else None,
        dialogue_kind="product" if is_product_dialogue else "generic",
        arm=arm,
        targeted=targeted,
        dialogue_id=dialogue_id,
    )

    def _emit_turn(t: DialogueTurn) -> None:
        if on_turn is not None:
            on_turn(t)
        if on_event is not None:
            try:
                on_event(
                    {
                        "type": "dialogue_turn",
                        "dialogue_id": dialogue_id,
                        "speaker": t.speaker,
                        "text": t.text,
                    }
                )
            except Exception:
                pass

    def _relay_or_raise(sender: Persona, receiver: Persona, text: str) -> None:
        payload = f"{dialogue_id}|{sender.agent_id}|{receiver.agent_id}|{text}"
        try:
            route = transport.send(sender, receiver, payload)
            log.debug(
                "transport send ok dialogue_id=%s sender=%s receiver=%s route=%s",
                dialogue_id,
                sender.agent_id,
                receiver.agent_id,
                route,
            )
        except Exception as e:
            if transport_required:
                raise
            log.warning(
                "transport send failed (fallback local dialogue) dialogue_id=%s sender=%s receiver=%s err=%s",
                dialogue_id,
                sender.agent_id,
                receiver.agent_id,
                e,
            )

    def _normalize_turn(text: str) -> str:
        s = " ".join((text or "").strip().split())
        if not s:
            return "Okay."
        s = re.sub(r"(?m)^\s*[-*]\s+", "", s)
        s = re.sub(r"(?m)^\s*\d+[.)]\s+", "", s)
        lowered = s.lower()
        for pref in _CANNED_PREFIXES:
            if lowered.startswith(pref + "!") or lowered.startswith(pref + ".") or lowered.startswith(pref + ","):
                s = s[len(pref) :].lstrip("!.,:; ").strip()
                break
        parts = re.split(r"(?<=[.!?])\s+", s)
        s = " ".join(p for p in parts if p)[:220].strip()
        if not s:
            return "Okay."
        return s

    def _too_similar(a: str, b: str) -> bool:
        if not a or not b:
            return False
        a_n = re.sub(r"\W+", "", a.lower())
        b_n = re.sub(r"\W+", "", b.lower())
        return a_n == b_n

    # Fire dialogue_started up front so the UI can render an empty card.
    if on_event is not None:
        try:
            on_event(
                {
                    "type": "dialogue_started",
                    "dialogue_id": dialogue_id,
                    "buyer_id": buyer.agent_id,
                    "buyer_age": buyer.age,
                    "buyer_gender": buyer.gender,
                    "buyer_occupation": buyer.occupation,
                    "buyer_income_band": buyer.income_band,
                    "seller_id": seller.agent_id,
                    "seller_occupation": seller.occupation,
                    "establishment_id": est.id,
                    "establishment_kind": est.kind.value,
                    "product_id": result.product_id,
                    "dialogue_kind": result.dialogue_kind,
                    "arm": arm,
                    "targeted": targeted,
                    "sim_minute": sim_minute,
                    "day_of_year": day_of_year,
                }
            )
        except Exception:
            pass

    # Free opening line from the seller — saves one LLM call and grounds the
    # conversation in the right context.
    kind_phrase = est.kind.value.replace("_", " ")
    greeting = _opening_greeting(est.kind, seller.occupation)
    seller_history.append(LLMMessage(role="assistant", content=greeting))
    buyer_history.append(LLMMessage(role="user", content=greeting))
    opening = DialogueTurn(speaker="seller", text=greeting)
    _relay_or_raise(seller, buyer, greeting)
    result.turns.append(opening)
    _emit_turn(opening)

    end_reason = "max_turns"
    for _ in range(max_turns):
        # ---- Buyer's turn -------------------------------------------------
        resp = agent_gw.chat(buyer_history, max_tokens=64, temperature=0.45)
        buyer_text = _normalize_turn(resp.text)
        _relay_or_raise(buyer, seller, buyer_text)
        turn = DialogueTurn(speaker="buyer", text=buyer_text)
        result.turns.append(turn)
        _emit_turn(turn)
        buyer_history.append(LLMMessage(role="assistant", content=buyer_text))
        seller_history.append(LLMMessage(role="user", content=buyer_text))

        if "[BUY]" in buyer_text.upper():
            end_reason = "buy"
            break
        if "[LEAVE]" in buyer_text.upper():
            end_reason = "leave"
            break

        # ---- Seller's turn ------------------------------------------------
        resp = agent_gw.chat(seller_history, max_tokens=72, temperature=0.35)
        seller_text = _normalize_turn(resp.text)
        _relay_or_raise(seller, buyer, seller_text)
        turn = DialogueTurn(speaker="seller", text=seller_text)
        result.turns.append(turn)
        _emit_turn(turn)
        seller_history.append(LLMMessage(role="assistant", content=seller_text))
        buyer_history.append(LLMMessage(role="user", content=seller_text))

        # Stop loop if both sides start parroting near-identical turns.
        if len(result.turns) >= 4:
            last = result.turns[-1].text
            prev_same = result.turns[-3].text
            if _too_similar(last, prev_same):
                end_reason = "leave"
                break

    result.end_reason = end_reason
    result.duration_s = time.monotonic() - t0

    if extract_outcome:
        result.outcome = _extract_outcome(result, seller.occupation, active_product)

    if on_event is not None:
        try:
            on_event(
                {
                    "type": "dialogue_ended",
                    "dialogue_id": dialogue_id,
                    "end_reason": end_reason,
                    "duration_s": result.duration_s,
                    "outcome": result.outcome,
                    "dialogue_kind": result.dialogue_kind,
                    "arm": result.arm,
                    "targeted": result.targeted,
                    "product_id": result.product_id,
                }
            )
        except Exception:
            pass

    # Log the whole thing (dialogue + outcome) to the event log.
    if log_to is not None:
        log_to.append(
            kind="dialogue",
            sim_minute=sim_minute,
            day_of_year=day_of_year,
            payload={
                "dialogue_id": result.dialogue_id,
                "buyer_id": result.buyer_id,
                "seller_id": result.seller_id,
                "establishment_id": result.establishment_id,
                "establishment_kind": result.establishment_kind,
                "product_id": result.product_id,
                "dialogue_kind": result.dialogue_kind,
                "arm": result.arm,
                "targeted": result.targeted,
                "turns": [{"speaker": t.speaker, "text": t.text} for t in result.turns],
                "end_reason": result.end_reason,
                "outcome": result.outcome,
                "duration_s": result.duration_s,
            },
        )

    # Reference kind_phrase so linter doesn't trip over the unused local
    # (it's used in the f-string-style fallback for older greetings).
    _ = kind_phrase
    return result


# ---------------------------------------------------------------------------
# Outcome extraction
# ---------------------------------------------------------------------------


def _extract_outcome(
    result: DialogueResult,
    seller_role: str,
    product: ProductBrief | None,
) -> dict[str, Any]:
    """Run the audit-tier extractor on the transcript.

    When ``product`` is set we use the richer product-aware schema
    (intrinsic_motivator, seller_winning_phrase, objections_raised,
    target_fit, units, price_sensitivity). Otherwise we fall back to
    the generic shopping-outcome schema.
    """
    transcript = "\n".join(f"{t.speaker.upper()}: {t.text}" for t in result.turns)
    if product is not None:
        prompt = PRODUCT_EXTRACTION_PROMPT.format(
            role=seller_role.replace("_", " "),
            kind=result.establishment_kind.replace("_", " "),
            transcript=transcript,
            product_name=product.name,
            product_pitch=product.short_description,
            product_price=f"{product.price:.2f} {product.currency}",
        )
    else:
        prompt = EXTRACTION_PROMPT.format(
            role=seller_role.replace("_", " "),
            kind=result.establishment_kind.replace("_", " "),
            transcript=transcript,
        )

    try:
        gw = get_gateway(tier="audit")
        return gw.chat_json(
            [LLMMessage(role="user", content=prompt)],
            temperature=0.0,
            max_tokens=400,
        )
    except Exception as e:
        # No OpenAI key (or audit gateway misconfigured) — fall back to a
        # rule-based outcome. The transcript is still useful; the structured
        # extraction can be backfilled later by replaying the event log.
        purchased = result.end_reason == "buy"
        if product is not None:
            return {
                "purchased": purchased,
                "units": 1 if purchased else 0,
                "price_paid": product.price if purchased else None,
                "decisive_factor": "salesperson_pitch" if purchased else "none",
                "intrinsic_motivator": "none",
                "seller_winning_phrase": None,
                "objections_raised": [] if purchased else ["other"],
                "price_sensitivity": "medium",
                "target_fit": "none",
                "regret_signal": 0.0,
                "followup_intent": None,
                "_fallback": True,
                "_fallback_reason": str(e)[:160],
            }
        return {
            "purchased": purchased,
            "product": None,
            "price_paid": None,
            "decisive_factor": "salesperson_pitch" if purchased else "none",
            "regret_signal": 0.0,
            "followup_intent": None,
            "_fallback": True,
            "_fallback_reason": str(e)[:160],
        }


# ---------------------------------------------------------------------------
# Per-establishment opening lines (no LLM call, saves a turn)
# ---------------------------------------------------------------------------

_GREETINGS: dict[EstablishmentKind, str] = {
    EstablishmentKind.COFFEE_SHOP: "Hi! What can I get started for you?",
    EstablishmentKind.SUPERMARKET: "Hey, did you find everything alright?",
    EstablishmentKind.RESTAURANT: "Hi there — table for one, or are you here for takeaway?",
    EstablishmentKind.PUB: "Evening. What'll it be?",
    EstablishmentKind.HARDWARE: "Hey, anything I can help you find?",
    EstablishmentKind.PHARMACY: "Hi — how can I help you today?",
    EstablishmentKind.CLOTHING: "Hi, welcome in. Looking for anything in particular?",
    EstablishmentKind.BANK: "Good afternoon — how can I help you?",
}


def _opening_greeting(kind: EstablishmentKind, _role: str) -> str:
    return _GREETINGS.get(kind, "Hi, how can I help you?")
