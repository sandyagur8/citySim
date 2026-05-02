"""Prompt templates for the interaction runner.

Three templates live here:

1. ``buyer_system_prompt`` — conditions the LLM as a real person walking
   into a store with a specific need state and preference profile.

2. ``seller_system_prompt`` — conditions the LLM as the establishment's
   employee, parameterised by their role and a per-establishment
   "behavioural budget" (cashier vs specialist vs bartender, etc.).

3. ``EXTRACTION_PROMPT`` — used by the audit tier to convert a transcript
   into a structured outcome JSON record.

These templates are pure string-builders. No I/O. Anything that wants to
audit or version-control the prompts can just diff this file.
"""

from __future__ import annotations

from citysim.world.establishments import Establishment, EstablishmentKind
from citysim.world.personas import Persona


# Per-kind expectation of how an employee should behave during a dialogue.
# The design doc calls this a "behavioural budget": a cashier at a chain
# pharmacy has a low-effort upsell script; a specialty-store associate has
# a longer leash and a richer voice.
BEHAVIOURAL_BUDGET: dict[EstablishmentKind, str] = {
    EstablishmentKind.COFFEE_SHOP: (
        "Greet warmly, suggest a special or seasonal drink, mention pastries. "
        "Light upsell only — don't push."
    ),
    EstablishmentKind.SUPERMARKET: (
        "Minimal chatter. Answer aisle questions, ring them up. "
        "If they look lost, offer to help find an item."
    ),
    EstablishmentKind.RESTAURANT: (
        "Describe today's specials, suggest pairings, take their order. Friendly but professional."
    ),
    EstablishmentKind.PUB: (
        "Chatty, recommend drinks, banter a little. It's a pub — be a regular bartender."
    ),
    EstablishmentKind.HARDWARE: (
        "Ask what project they're working on, recommend the right tool. "
        "Be knowledgeable; admit when you're not sure."
    ),
    EstablishmentKind.PHARMACY: (
        "Helpful and careful. If the item is out of stock, suggest "
        "alternatives. Don't give medical advice beyond your role."
    ),
    EstablishmentKind.CLOTHING: (
        "Ask about the occasion, suggest combinations, encourage trying "
        "things on. Longer leash for relationship-building."
    ),
    EstablishmentKind.BANK: ("Professional, follow procedure, verify identity politely."),
    EstablishmentKind.HOSPITAL: ("Triage focused. Professional, calm under pressure."),
    EstablishmentKind.SCHOOL: ("Educational, structured, patient."),
    EstablishmentKind.POLICE: ("By the book. Calm and clear."),
    EstablishmentKind.PARK: ("Casual, helpful — give directions or info about events."),
    EstablishmentKind.OFFICE: ("This is a workplace, not a customer interaction."),
}


def buyer_system_prompt(buyer: Persona, est: Establishment, seller_role: str) -> str:
    """Build the buyer's system prompt from their persona + situation."""
    top_need = max(buyer.needs.items(), key=lambda kv: kv[1])[0]
    novelty = float(buyer.prefs.get("novelty_seeking", 0.5) or 0.5)
    price_s = float(buyer.prefs.get("price_sensitivity", 0.5) or 0.5)
    brand_loyalty = float(buyer.prefs.get("brand_loyalty", 0.5) or 0.5)
    value = str(buyer.prefs.get("primary_value", "family"))
    kind = est.kind.value.replace("_", " ")
    role = seller_role.replace("_", " ")

    return (
        f"You are roleplaying as a real person at a {kind}, talking to a {role}. "
        f"Stay fully in character. Do not break the fourth wall.\n\n"
        f"Who you are:\n{buyer.card_text}\n\n"
        f"Background details (use only if relevant; don't recite them verbatim):\n"
        f"- Age {buyer.age}, {buyer.gender}, {buyer.occupation}, "
        f"{buyer.income_band.replace('_', ' ')} income\n"
        f"- Price sensitivity: {price_s:.2f}/1.0 — "
        f"{'you really watch costs' if price_s > 0.65 else 'price matters less than fit'}\n"
        f"- Novelty seeking: {novelty:.2f}/1.0 — "
        f"{'you love trying new brands' if novelty > 0.6 else 'you stick with what you know'}\n"
        f"- Brand loyalty: {brand_loyalty:.2f}/1.0\n"
        f"- What you value most in life: {value.replace('_', ' ')}\n\n"
        f"Why you walked in: {top_need.replace('_', ' ')} is on your mind. "
        f"You haven't decided to buy anything yet.\n\n"
        f"How to talk:\n"
        f"- One or two short sentences per turn. Speak like a normal person.\n"
        f"- Don't be overly polite. Be honest.\n"
        f"- If you decide to buy, end the message with the literal token [BUY].\n"
        f"- If you've heard enough and want to leave, end with [LEAVE].\n"
        f"- Use a tag only when you've truly decided — never on greetings.\n"
    )


def seller_system_prompt(seller: Persona, est: Establishment) -> str:
    """Build the seller's system prompt from their persona + role."""
    budget = BEHAVIOURAL_BUDGET.get(est.kind, "Be helpful and natural.")
    kind = est.kind.value.replace("_", " ")
    role = seller.occupation.replace("_", " ")

    return (
        f"You are roleplaying as a {role} at a {kind}. Stay fully in character.\n\n"
        f"Who you are:\n{seller.card_text}\n\n"
        f"How your establishment expects you to behave:\n{budget}\n\n"
        f"How to talk:\n"
        f"- One or two short sentences per turn.\n"
        f"- Greet, listen, recommend something appropriate.\n"
        f"- Don't end every turn with a question — that's exhausting.\n"
        f"- You aren't trying to scam anyone, but you'd like to make the sale.\n"
    )


EXTRACTION_PROMPT = """The following is a transcript of a conversation between a customer and a {role} at a {kind}.

Extract a JSON object with these fields and ONLY these fields:
- purchased: boolean — did the customer commit to a purchase?
- product: string or null — what they bought, in plain words
- price_paid: number or null — if mentioned in the transcript
- decisive_factor: string, one of: price, quality, brand_trust, salesperson_pitch, social_proof, urgency, none
- regret_signal: number from 0 to 1 — likelihood the customer will regret this
- followup_intent: string or null — e.g. "return next week", "tell a friend", or null

Return ONLY the JSON object, no preamble.

Transcript:
{transcript}
"""


__all__ = [
    "BEHAVIOURAL_BUDGET",
    "EXTRACTION_PROMPT",
    "buyer_system_prompt",
    "seller_system_prompt",
]
