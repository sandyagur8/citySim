"""Product brief: the unit-of-test that drives a simulation.

Sim-city can run as a generic city sim (no product set) or as a
product-testing harness. When a product brief is loaded, the dialogue
worker biases shop conversations toward selling that product, the
outcome extractor pulls richer fields (intrinsic motivator, winning
phrase, objections), and the day summary produces product-aware
sections (units sold, revenue, top motivators, A/B comparison).

Briefs live at ``$CITYSIM_HOME/product.json`` (default ``~/.citysim``).
Use ``citysim init-product`` to create one interactively, or write the
JSON file directly.
"""

from .brief import (
    AGE_BANDS,
    INCOME_BANDS,
    POSITIONING_OPTIONS,
    ProductBrief,
    TargetFilter,
    clear_product,
    default_product_path,
    load_product,
    load_products,
    matches_target,
    save_product,
    save_products,
)

__all__ = [
    "AGE_BANDS",
    "INCOME_BANDS",
    "POSITIONING_OPTIONS",
    "ProductBrief",
    "TargetFilter",
    "clear_product",
    "default_product_path",
    "load_product",
    "load_products",
    "matches_target",
    "save_product",
    "save_products",
]
