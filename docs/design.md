# City Simulator — System Design Document

**A 1M-agent synthetic city for product testing.**
Author: prepared for Melbin · Date: 2026-05-01 · Status: Draft v1

---

## 1. Executive summary

The goal is a closed-loop simulation in which one million LLM-backed agents live a recognisable urban life — they wake, work, parent, gossip, shop, eat, save, splurge, regret — so that a product team can drop a new SKU into the world and watch how it spreads, who buys it, what they say to the salesperson, and which personas resist. Businesses are first-class agents too, run by hierarchies of employee-agents whose only goal during open hours is to convert footfall into revenue. Every modelled interaction is a business interaction, and every business interaction resolves into a structured outcome plus, when sampled, a verbatim dialogue.

The product output is not "a number." It is a longitudinal log of personas, exposures, conversations, and conversions that you can slice by demographic, by need bucket, by store, by hour, and by product variant. You can A/B two pricing strategies, two pitches, two shelf placements; you can introduce a substitute and watch the incumbent bleed; you can spot the persona segments who never convert no matter what.

This document covers agent design, population generation, geography, the establishment model, the time-and-event loop, the interaction and purchase models, the product-introduction mechanic, the storage layer, the LLM gateway, the scaling path from 1k to 1M, the honest cost picture, and a four-phase roadmap. There is one section you should not skip: **§14 Honest cost reality**. At 1M agents with every interaction LLM-driven, a single simulated day costs roughly the same as a mid-size Anthropic API account runs in a month. Phase 0 is fine; Phase 3 needs a real budget conversation.

---

## 2. Top-level architecture

The system has six layers, top to bottom.

The **persona layer** owns who the agents are: their demographics, beliefs, tastes, family and social ties, and their internal need state. Personas are generated once per simulation run from a parameterised population profile (e.g. "mid-size US Sun Belt city, median household income $68k, 22% Hispanic, 14% college-educated"). They are persisted in Postgres and a vector store; they evolve slowly during a run as agents acquire goods, age, and update their preferences.

The **world layer** owns geography and time. The city is a grid of cells with zoning, density, and amenity counts. Time advances in one-minute ticks. The world layer also owns establishments: their location, hours, staffing, inventory, and pricing.

The **schedule layer** is what makes the world feel alive. Every agent has a daily plan generated from their persona — a sequence of *intentions* like "leave home at 7:42, drive to office, eat lunch near work, pick up groceries on the way home." Schedules are stochastic and re-plannable: an agent who runs out of diapers replans; an agent invited to drinks replans; an agent exposed to a compelling ad replans.

The **interaction layer** is the loop where agents and establishments meet. When a buyer-agent enters a store with a need, the layer matches them to an available employee-agent and runs a dialogue. Dialogues are LLM-driven, role-played by two persona-conditioned model calls, and resolve into a structured outcome record.

The **economy layer** maintains every agent's cash, credit, debt, savings, and budget envelopes. Every transaction debits a buyer envelope and credits a business; businesses pay employees, restock, and report P&L.

The **observability layer** is what you actually consume. Every event — exposure, conversation turn, purchase, decline, regret — is appended to an immutable log. Reports, dashboards, and persona-level summaries read from this log.

```
┌──────────────────────────────────────────────────────────────────┐
│  Observability  (events, dialogues, transactions → reports)      │
├──────────────────────────────────────────────────────────────────┤
│  Economy  (envelopes, cash, credit, P&L)                         │
├──────────────────────────────────────────────────────────────────┤
│  Interaction  (LLM dialogue runner, outcome resolver)            │
├──────────────────────────────────────────────────────────────────┤
│  Schedule  (intention queue, replanning triggers)                │
├──────────────────────────────────────────────────────────────────┤
│  World  (grid, places, establishments, time)                     │
├──────────────────────────────────────────────────────────────────┤
│  Persona  (1M agents in Postgres + vector DB)                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. The agent model

An agent is a row in Postgres plus a vector embedding plus a hot mutable state object held in Redis during a run. The persistent schema looks like this (truncated for readability; the full version is in `schemas/agent.json`):

```json
{
  "id": "ag_8f3a...",
  "demographics": {
    "age": 34, "gender": "F", "ethnicity": "south_asian",
    "education": "bachelors", "income_decile": 7,
    "marital_status": "married", "sexual_orientation": "straight",
    "dependents": [{"id": "ag_...", "relation": "child", "age": 4}]
  },
  "location": { "home_cell": [42, 17], "work_cell": [55, 30] },
  "household_id": "hh_2c91...",
  "profession": {
    "job_title": "ux_designer", "employer_id": "biz_4f...",
    "shift": "0900-1700", "income_monthly": 7800
  },
  "beliefs": {
    "religion": "hindu", "religiosity": 0.4,
    "political_lean": -0.2, "values": {"family": 0.9, "career": 0.7, "tradition": 0.5}
  },
  "tastes": {
    "cuisines": ["south_indian", "thai", "italian"],
    "music": ["indie", "lofi", "bollywood_2010s"],
    "brands_loved": ["uniqlo", "muji"], "brands_disliked": ["fast_fashion_x"]
  },
  "traits_big5": { "O": 0.7, "C": 0.6, "E": 0.4, "A": 0.7, "N": 0.3 },
  "drivers": {
    "frugality": 0.6, "vanity": 0.3, "novelty_seeking": 0.5,
    "envy": 0.2, "pride": 0.4, "lust": 0.3, "greed": 0.2, "laziness": 0.4
  },
  "social_graph": {
    "family": ["ag_...", "ag_..."],
    "close_friends": ["ag_...", "ag_..."],
    "colleagues": ["ag_...", ...],
    "community": ["temple_42", "moms_of_indiranagar"]
  },
  "economy": {
    "cash": 4200, "credit_limit": 9000, "credit_used": 1100,
    "savings": 28000, "debt": 0,
    "envelopes": {
      "groceries": 600, "dining": 250, "transport": 300,
      "utilities": 220, "clothing": 150, "mating_signal": 0,
      "status_signal": 200, "investment": 800, "emergency": 400
    }
  },
  "owned": [{"sku": "iphone_14", "since": "2023-09-01"}, ...],
  "exposure_log": [{"sku": "newcola_zero", "t": "2026-04-29T08:14", "valence": 0.2}]
}
```

The hot mutable state — what the agent is doing right now, what it intends next, what its current need-urgency vector looks like — lives in Redis keyed by agent id. This split keeps the persona heavy-write-once, hot-read-many; the runtime state is cheap to update at every tick.

The 8 need buckets you specified — survival, dependents, essentials, clothing, mating, status, investment, savings — are modelled as a need-state vector with a per-bucket *urgency* that decays toward zero on satisfaction and rises with time/triggers. Survival urgency rises if calorie intake falls below the agent's metabolic baseline. Dependents urgency rises if a child runs out of diapers, school fees come due. Status urgency rises after social events where a peer flexes (envy is a coupling coefficient on this). Mating urgency is non-zero only for single agents in a target age window and gets boosted by upcoming social events. The 8 drivers in your spec — laziness, financial_insecurity, greed, lust, envy, pride, vanity, frugality, novelty — are persona-fixed coefficients that re-weight the need vector and the purchase utility function.

---

## 4. Population generation

Generating one million coherent personas is harder than it looks. You cannot independently sample age, profession, religion, and income — you get a 23-year-old retired Hindu cardiac surgeon. The right tool is a **joint distribution** that respects realistic correlations.

The generator runs in three passes. Pass one samples *household types* from a parameterised mix (single, couple-no-kids, nuclear, single-parent, multi-gen, roommates, group-quarters). Each city profile defines this mix; you can dial it for a US Sun Belt city, an Indian metro, a European capital, a college town. Pass two fills household slots with anchor adults sampled from a copula over (age, gender, ethnicity, education, profession, income) — copulas are trained from synthetic Census-style joint tables shipped with the simulator. Pass three samples dependents conditional on the anchors, generates the social graph (family edges from household, colleague edges from employer, friendship edges via a small-world model with assortativity on age/profession/community), and assigns home and work cells respecting commute distance distributions.

The output is a 1M-row Postgres table where the marginals look like real census, the joints look like real life, and the social graph has the right clustering coefficient and degree distribution. Determinism is important: every run is keyed by a `seed`, so two runs with the same seed produce identical populations and you can A/B *only* the product variable.

A practical note: do not generate 1M personas by 1M LLM calls. That is wasteful and slow. Instead, generate them programmatically from distributions, then use the LLM at runtime only to *speak as* a persona during a dialogue. The persona's text persona-card (a 200-word prose description) can be synthesised from the structured fields by template, and only enriched by LLM for the subset of personas the simulation actually exercises in a given run.

---

## 5. Geography and places

The city is a grid of cells, default 100×100 with a configurable scale (one cell ≈ 200m for a small city, one cell ≈ 500m for a metro). Each cell has a **zoning vector**: residential weight, commercial weight, industrial weight, civic weight, green weight. Zoning is generated by a simple radial model — dense commercial in the centre, residential rings, industrial wedges on the outskirts — but a city profile can override this.

Each cell hosts a population of establishments drawn from a profile-defined density. A typical commercial cell in a mid-size US city might have one supermarket, two coffee shops, a hardware store, a pharmacy, three restaurants, a bank branch, and four small retail outlets. A residential cell has none, or one corner store. Essential services — police, fire, hospitals — are placed by hand-tuned coverage rules.

Movement between cells uses a precomputed travel matrix. Agents have a **mode** preference (car, transit, bike, walk) drawn from persona, and travel time is `distance × mode_multiplier × congestion(t)`. Congestion is a coarse function of hour-of-day. We do not simulate roads. We simulate *time-to-arrive*, which is what affects schedule feasibility, and we simulate *which establishments are visit-eligible from where*.

---

## 6. Establishments

An establishment is itself an agent — a collective whose goal during open hours is profit. Its schema:

```json
{
  "id": "biz_walmart_42",
  "type": "supermarket", "brand": "walmart",
  "cell": [55, 30],
  "hours": [{"open": "07:00", "close": "23:00"}],
  "owner_id": "ag_...",
  "employees": [
    {"agent_id": "ag_...", "role": "manager", "shift": "0700-1500"},
    {"agent_id": "ag_...", "role": "cashier", "shift": "0900-1700"},
    {"agent_id": "ag_...", "role": "stocker", "shift": "0500-1300"}
  ],
  "inventory": [
    {"sku": "milk_1gal", "price": 3.79, "cost": 2.40, "shelf_facings": 12},
    ...
  ],
  "pricing_strategy": "edlp",
  "kpi_daily": {"target_revenue": 28000, "target_margin": 0.18}
}
```

The default hours for retail are 09:00–17:00; restaurants open 11:00 and close 23:00; clubs 21:00–03:00; convenience stores, hospitals, police, fire, and 24-hour gas stations run 24/7. A small set of brand templates ships with the simulator: McDonald's, Walmart, Costco, Starbucks, Target, Kroger, Home Depot, CVS, plus generic `local_*` templates for the long tail. Each template defines staffing model, inventory class, pricing posture, and a sales-pitch style guide that goes into the salesperson system prompt. Publicly listed-company SKUs flow into the consumer market through these establishments.

Crucially, an establishment owns *behavioural budgets* on its employees. A cashier at a chain pharmacy has a low-effort upsell script. A salesperson at a specialty store has a longer leash and a richer persona. A real-estate agent runs a multi-day relationship. The dialogue prompt template is parameterised by employee role and establishment type.

---

## 7. The time and event loop

A simulated day runs from 00:00 to 23:59 in one-minute ticks. (Note: your spec said "12 AM to 12 PM" but described a full daily cycle with clubs open till 3am — I'm reading that as 00:00 to 23:59. Easy to flip if I'm wrong.)

The engine is a discrete-event simulator. Each agent owns a personal queue of intentions for the day, generated at midnight by a planner conditioned on persona and on the day's calendar (weekday, weekend, payday, festival, weather). Intentions are entries like `[07:30, "wake_and_breakfast", home]`, `[08:15, "commute_to_work"]`, `[09:00, "work"]`, `[12:30, "lunch", nearby_food_cell]`, `[18:00, "grocery_run", target_store]`, `[19:30, "home_dinner"]`.

The engine advances time, fires events, and resolves co-location. When two or more agents end up at the same establishment in the same tick window, the establishment's matching logic pairs buyers with available employees, and an interaction event is created. Most ticks for most agents are uneventful (working, sleeping, commuting); the engine batches those at high speed. Computational cost is dominated by the interaction events.

Replanning happens on three triggers: a need bucket crossing its urgency threshold (you're out of milk → grocery insertion), a social trigger (friend invites to dinner), and an exposure trigger (an ad or peer recommendation passing a salience filter).

---

## 8. The interaction model — LLM-driven dialogue

This is the core of what makes the simulation valuable, and it is the most expensive part. Every business interaction you choose to model in full fidelity is two LLM calls per turn, 5–10 turns, plus a structured outcome extraction.

The runner works as follows. When buyer B enters establishment E and is matched with employee P, the runner constructs three things: a **buyer system prompt** containing B's persona card, current need state, current envelope balances, current exposure log for relevant SKUs, and a behaviour rubric ("you are this person, your goal in this interaction is to fulfil need X within budget Y, you push back if pressured beyond your comfort"); a **seller system prompt** containing P's role, E's pricing posture, today's promotions, the SKU set in scope, and a sales rubric ("your job is to maximise revenue and margin within E's brand voice; you read the buyer's persona, you adapt"); and a **scene prompt** ("Buyer has just walked in looking at the cereal aisle.").

The two models alternate turns. The conversation ends when (a) the seller closes a sale, (b) the buyer disengages, (c) a max-turns cap is hit (default 10). After termination, an **outcome extractor** runs a third small LLM call that converts the dialogue into a structured record:

```json
{
  "interaction_id": "int_...",
  "buyer_id": "ag_...", "seller_id": "ag_...", "biz_id": "biz_...",
  "t_start": "2026-05-01T18:14",
  "skus_discussed": ["newcola_zero", "cocacola_zero"],
  "skus_purchased": [{"sku": "newcola_zero", "qty": 2, "price": 3.49}],
  "outcome": "purchased",
  "buyer_motivation_extracted": "novelty + low_calorie_diet_goal",
  "seller_levers_used": ["health_framing", "limited_time_promo"],
  "objections_raised": ["unfamiliar_brand"],
  "objections_resolved": ["unfamiliar_brand"],
  "decisive_factor": "health_framing",
  "regret_risk": 0.15,
  "dialogue_ref": "s3://.../int_....jsonl"
}
```

A subtle but important design choice: the buyer model **does not have full visibility into the seller's incentives**, and vice versa. They each see only their own system prompt. This prevents collusion-type artifacts where both agents converge to "yes" to please the orchestrator. The outcome is genuinely emergent.

You said you want every interaction LLM-driven. The architecture supports that. §14 covers the cost honestly. The recommended phase-1 default is full LLM at 1k–10k agents to validate dialogue quality, with the option to switch to **hybrid mode** at scale: a fast rule-based outcome model handles the long tail of "buy a gallon of milk" interactions, and the LLM is reserved for new-product encounters, high-ticket items, and a representative sample of routine ones for distillation. This is a switch in config, not a rewrite.

---

## 9. The need-utility-purchase model

A purchase decision in the simulator is a three-gate function. The buyer agent considers a SKU. **Gate one** is *want*: utility above threshold. **Gate two** is *can*: cash or credit available. **Gate three** is *justify*: socially defensible in the agent's reference circles, given the agent's pride and envy coefficients.

Utility for buyer B and SKU S in context C is:

```
U(B, S, C) = α · need_fit(B, S)
           + β · brand_affinity(B, S)
           + γ · social_proof(B, S)
           + δ · novelty_score(B, S)
           - ε · price_burden(B, S)
           - ζ · regret_risk(B, S, C)
           + η · persuasion_delta(C)
```

Need fit comes from how well S addresses B's currently urgent buckets. Brand affinity is a learned vector match between B's tastes and S's brand. Social proof is the fraction of B's close friends and community who own S, weighted by influence. Novelty matters more for high-O (open-to-experience) personas. Price burden is `S.price / B.daily_disposable`; it bites differently for a frugal agent than a vain one. Regret risk rises for unfamiliar brands and for purchases that cross envelope limits. Persuasion delta is the dialogue-derived bump from a successful seller pitch.

The drivers from your spec re-weight the coefficients per agent: high-greed agents weight `need_fit` more heavily on status-related products; high-envy agents weight `social_proof` more; high-frugality agents weight `price_burden` more. Lust and pride mostly affect mating- and status-bucket purchases.

A purchase happens iff `U > θ_B` (an agent-specific threshold, lower for high-novelty-seeking personas) AND `cash_or_credit_available` AND the *justifiability check* passes. Justifiability is a small lookup: "would this purchase be defensible to {spouse, parents, peer group}?" — we model it as a coefficient on certain product categories. A devout-religious agent buying a luxury watch fails the justifiability check unless they're high-vanity-low-religiosity within that category.

---

## 10. Product introduction and exposure

A product launch is a parameter set: SKU, price, target stores, marketing spend, channel mix, launch date. On launch, the SKU appears in inventory at target stores and in the **exposure stream**.

The exposure stream is how new products reach agents who don't immediately walk into a store with intent to buy. There are five exposure channels: in-store shelf encounter (passive), targeted ad (probabilistic, persona-keyed), social peer (a friend bought it), influencer endorsement (community-keyed), and earned media (journalist-agent reviews flow into community channels). Each exposure adds an entry to the agent's `exposure_log` with a valence and a salience score.

Salience compounds. Repeat exposures lift the agent's *familiarity* multiplier on `U`. Familiarity is the effect that makes most successful new products work: people don't buy on first sight; they buy on third or fifth, after the brand has crossed a recognition threshold and a friend has signalled validation. Modeling this explicitly is what gives the simulator predictive value over a one-shot survey.

For a new product, the agent's evaluation considers two paths: *substitution* (does S replace something I already buy?) and *unmet-need* (does S address an urgent bucket nothing currently fills?). Substitution decisions weigh `U(B, S) - U(B, S_incumbent)`; unmet-need decisions weigh `U(B, S)` against threshold. Most of the meaningful product launches will be substitution plays, and the simulator's job is to surface the persona segments where substitution wins, the prices at which it does, and the pitches that close it.

---

## 11. Data model and storage

Personas, households, employers, establishments, and inventory live in **Postgres** — relational, queryable, stable. Hot agent state (current intention, current need vector, current envelope balances) lives in **Redis** during a run; it's flushed to Postgres at end-of-day for persistence. Persona embeddings live in a **vector DB** (Qdrant or pgvector) for fast similarity lookup — useful when a salesperson agent needs "what kind of person is this?" context faster than reading the full persona blob.

Events — every exposure, every dialogue, every purchase, every decline — go to an **append-only log** stored as Parquet on local disk for the prototype and on object storage (S3 or equivalent) for scale runs. Dialogues are JSONL, one file per interaction, indexed by interaction id. The structured outcomes are duckdb-queryable.

Reports query Parquet via DuckDB for ad-hoc analysis, and a small Streamlit or Observable dashboard renders standard views (adoption curves, segment heatmaps, top objections). The dialogue corpus is browseable by interaction id and by filter (segment, SKU, outcome).

---

## 12. Tech stack recommendation — local-first on Apple Silicon

The prototype runs entirely on a single MacBook M4 Pro with 24 GB unified memory and a 20-core GPU. No paid API calls, no cloud GPU, no waiting on rate limits. The stack is Python 3.12 + asyncio for the simulator core, Pydantic for schemas, Postgres + pgvector + Redis for state, DuckDB + Parquet for analytics, FastAPI for the control plane and the visual-interface backend, and a local LLM runtime for dialogue and extraction.

**LLM runtime on Apple Silicon.** vLLM is CUDA-only and not an option here. The two production-grade choices on M-series are MLX (Apple's native ML framework, best Metal-GPU utilisation, ~30–50% faster than llama.cpp on the same model) and llama.cpp via Ollama (most ergonomic developer experience, OpenAI-compatible API out of the box). The recommended setup is Ollama for development convenience and MLX for serious runs, behind a single OpenAI-compatible shim so the simulator code never knows which is in use.

**Model selection at 24 GB.** Of the 24 GB of unified memory, roughly 16–18 GB is realistically available for model weights and KV cache after macOS, the simulator process, Postgres, and Redis take their share. Practical fits, with rough wall-time-per-token on the M4 Pro 20-core GPU:

- Llama 3.1 8B Instruct, q4_K_M (~5 GB) — strong default for both buyer and seller, ~40–60 tok/sec
- Qwen 2.5 7B Instruct, q4_K_M (~4.5 GB) — slightly faster, better multilingual if your city profile isn't US-English
- Phi-4 14B, q4 (~9 GB) — best instruction-following in this tier, ~20–30 tok/sec
- Qwen 2.5 14B Instruct, q4 (~9 GB) — comparable to Phi-4, often better at roleplay/persona consistency
- Llama 3.2 3B Instruct, q8 (~3.5 GB) — the cheap "routine tier" model for buy-milk interactions in hybrid mode

What does **not** fit on 24 GB: any 32B+ model (Mistral Small 24B is borderline-impossible after KV cache), and no 70B at any quantisation. To run 70B-class locally you need an M-series Ultra with 64–128 GB or a discrete-GPU Linux box. Pick the latest equivalent in each size class — by the time you read this there are likely fresher 8B and 14B models than the ones named above; the architecture is what matters, not the specific weights.

**The OpenAI-compatible gateway.** The simulator never calls a model directly. It calls a single FastAPI shim that exposes `POST /v1/chat/completions` and routes requests by *tier*:

```
model: "dialogue-default"     → 8B  via Ollama/MLX (most buyer/seller turns)
model: "dialogue-premium"     → 14B via MLX        (new-product encounters, high-stakes)
model: "outcome-extractor"    → 7B  + Outlines     (structured JSON, constrained decoding)
model: "dialogue-routine"     → 3B  via Ollama     (cheap tier for trivial interactions)
model: "audit-sample"         → optional Anthropic (1–5% sample for ground-truth)
```

This gateway is also the home of prefix caching (huge wins because persona cards repeat across thousands of interactions), request batching (Apple Silicon scales near-linearly to 4–8 concurrent prompts), and the token-budget governor. Spend a day building it right and every later phase is easier; in particular, the swap from local-only to hybrid-with-cloud is one config change.

**Realistic throughput on M4 Pro 24 GB.** With an 8B model at q4 and good prefix caching, expect 40–60 generated tokens/sec single-stream. A typical 8-turn buyer/seller exchange is ~2400 generated tokens, so an interaction takes ~50 sec wall time. A 1k-agent, 1-day Phase 0 sim with ~4 interactions per agent on average is ~4000 interactions × 50 sec = ~55 hours single-stream. That's too long for iteration; three levers compress it:

Concurrency: Apple Silicon handles 4–8 concurrent prompts on the 20-core GPU with near-linear throughput. Tight batching drops the run to ~7–14 hours. Routing the long tail of routine interactions to a 3B model drops it another 3–5×. Cutting average dialogue length from 8 turns to 5 cuts another third. With all three, a full Phase 0 sim-day lands in the 2–4 hour range — workable for nightly runs. For interactive development, scale down to 100 agents and you're at 10–20 minutes per sim-day, which is iteration-friendly.

**For scale phases beyond the laptop.** Introduce Ray for distributed agent execution, swap the gateway's `dialogue-default` route to point at a vLLM cluster running 70B (cloud H100s or owned hardware), keep the routine and extractor tiers small. Anthropic's batch API at the `audit-sample` tier gives a 50% discount and is fine for non-real-time grounding. Move events from local Parquet to Iceberg on object storage. The simulator code itself does not change.

---

## 13. Scaling path: 1k → 1M

The same simulator code runs at every scale; what changes is the hardware tier the gateway routes to and the fidelity policy.

| Phase | Agents | Sim period | Hardware | Dialogue model | Wall time / sim-day | Marginal $ / sim-day |
|---|---|---|---|---|---|---|
| 0a | 100 | 1 day | M4 Pro 24 GB | 8B local (Ollama/MLX) | 10–20 min | ~$0 |
| 0b | 1k | 1 day | M4 Pro 24 GB | 8B + 3B routine, batched | 2–4 hours | ~$0 |
| 1 | 10k | 1 week | M4 Pro overnight, or 1× cloud H100 | 8B local, or 70B cloud | overnight, or ~3 hours | ~$0 local · $50–$150 cloud |
| 2 | 100k | 1 month | 4–8× H100 (cloud or owned) | 70B + sampled extractor | ~1 day | ~$200–$500 |
| 3 | 1M | 1 month | 32–64× H100 cluster, hybrid | 70B for sampled, distilled for routine | ~6–12 hours | ~$2k–$5k |

The "dialogue model" column is the dial. At Phase 0–1 the laptop runs the whole thing locally on an 8B model, full LLM for every interaction, and those dialogues become the ground-truth corpus. At Phase 2 you train a distillation model (fine-tuned 3B-class on the Phase-0/1 corpus, or a classical classifier on persona+SKU features) that predicts outcome and persuasion lever from features alone, and you reserve full LLM dialogues for new-product encounters and a sampled audit. By Phase 3 the routine "buy milk" interactions resolve in microseconds via the distilled model, and LLM compute concentrates on the cases that matter to the report.

A natural intermediate hardware step before committing to cloud GPUs is a Mac Studio M4 Ultra with 192 GB or a 2× RTX 6000 Ada Linux box — either extends the local-first regime through Phase 1 cleanly and unlocks 70B-class dialogue without per-token billing.

---

## 14. Honest cost reality

For local-first runs on the M4 Pro, the marginal cost of a Phase 0 simulation is the electricity to keep the laptop on and your patience for a 2–4 hour wall time. There is no per-token bill. This changes how you work — you can re-run a Phase 0 sim fifty times in a week, varying parameters, without thinking about cost. That iteration speed is the real value of the local-first stack at small scale.

The cost wall returns at Phase 2–3 when the laptop is past its limits regardless of optimisation. Per your direction, the design treats every interaction as LLM-driven. Here's what that means at 1M agents.

Take a conservative average of 4 modelled interactions per agent per day (some agents have zero, some have ten). Each interaction is roughly 8 turns; each turn is roughly 400 tokens of input (system prompts + history) and 150 tokens of output. That's 4400 tokens per interaction split across two LLM calls. Plus an outcome-extraction call adding ~1k tokens.

```
1M agents × 4 interactions × 5400 tokens = 21.6B tokens / sim-day
```

At Haiku 4.5 pricing (~$1/M input, ~$5/M output, blended ~$2/M), that is **~$43k per simulated day**. Anthropic's batch API roughly halves this. A one-month simulation at full fidelity is ~$650k–$1.3M. That is real money.

Three levers bring this down without abandoning the LLM-first principle. **Sampling**: only 1–5% of routine interactions need full LLM treatment to sustain the reporting; the rest can be resolved by a distilled model. This drops cost 20–100×. **Caching**: many buyer-seller pairings on routine SKUs are template-similar; semantic caching of dialogue fragments cuts 30–50% of tokens. **Prompt compression**: the buyer system prompt is ~300 tokens of persona card, but in steady state most of that can be replaced by a reference id + a 50-token summary. Together these bring full-month 1M simulation into the low five figures, which is in the realm of "pay for it as a research expense."

The recommended posture: full LLM at Phase 0–1, with the fidelity policy and the distillation pipeline built in from day one so the switch at Phase 2 is a config change, not a rewrite.

---

## 15. Reporting and outputs

At the end of a simulated period, the standard report contains:

A **launch summary** for each newly introduced product: total exposures, total interactions, conversion rate, total units sold, revenue, repeat rate. Adoption curve over the period. Geographic and demographic heatmaps. Top five reasons for purchase (extracted from outcome records); top five objections; top three persuasion levers that closed the sale.

A **persona-segment view**: cluster the 1M agents into 30–50 segments by tastes/demographics, then for each segment show conversion rate on the new product, average price paid, decisive factor frequencies, and a representative dialogue. This is the part product teams actually read.

A **competitive view**: for each substitution play, show which incumbent SKU lost share, in which segments, at which price points.

A **dialogue browser**: filter by segment, SKU, outcome, decisive factor, store. Read the actual conversations. This is what makes the simulator different from a spreadsheet model — you get to read what the synthetic shopper said when they walked away.

A **calibration check**: a few sanity panels comparing the simulated population's spending patterns to known macro data (CPI category shares, retail mix). This exists so you can flag when the simulation has drifted into fantasy.

---

## 16. Visual interface — live city view

The report is what the simulator produces; the live visual is what makes it usable day-to-day. You should be able to open a browser window, see the synthetic city laid out on a grid, watch agents and traffic move through their day, see the sky shift through sunrise → midday → sunset → night, and click any person to read their persona and current intention. The visual is also a debugging tool — persona collapse, schedule bugs, ghost-town zoning, unrealistic congestion, all of these are obvious to the eye and invisible in a CSV.

**Architecture.** The viewer is a separate web app that subscribes to the simulator's event stream over WebSocket. It does not block simulation; it samples. The simulator publishes a position-and-state delta every N simulated minutes (default 5) plus discrete events (interactions started, purchases made, products launched) on a separate channel. The viewer renders from those streams in real time and is fully scrubbable when re-played from the recorded event log — meaning every past run is replayable forever, not just live ones.

**Rendering engine.** For up to ~50k agents simultaneously visible, deck.gl's `ScatterplotLayer` renders smoothly at 60 fps in a browser via WebGL. Beyond that, switch to aggregated rendering: `HeatmapLayer` or `HexagonLayer` at zoom-out, individual dots only when the user zooms into a cell. This is the same scaling pattern Uber uses for their movement visualisations and it works cleanly to 1M+ points. The base layer is a procedural grid coloured by zoning (residential warm, commercial cool, industrial grey, civic beige, parks green). Establishments are static icons sized by footfall. Vehicles are a separate sprite layer with simple lerp-between-cells animation.

**Agent visual encoding.** Each agent is a 2–3 px tinted dot whose colour encodes current activity: dim blue when sleeping, orange while commuting, neutral grey while at work, bright green while shopping, warm yellow while eating, magenta during leisure. Mode (car / bike / walk / transit) shown by a small glyph at high zoom. Click an agent → side panel with the persona card, today's intention queue, current need-urgency vector, recent purchases, recent dialogues, and a "follow this agent" toggle that locks the camera to them across ticks. Click an establishment → side panel with current footfall, today's revenue, conversion rate by segment, ongoing dialogues you can watch live, and the staff roster.

**Day-night cycle.** A full-screen overlay layer interpolates a lighting tint based on simulated time. Sunrise and sunset times come from a small solar-position calc using the city profile's latitude and date. The gradient runs from deep navy overnight through amber at sunrise, neutral white midday, gold-to-magenta at sunset, and back. Establishments turn on their lit-window state during their open hours and after dark — a chain pharmacy glowing at 2 AM next to dark retail blocks is visually unmistakable. The day-night cycle is partly cosmetic and partly informative: the visual rhythm makes it easy to feel whether the simulation has the right pulse — commute peaks, lunch rush, evening retail surge, club crowd at midnight.

**Time controls.** Play / pause, speed selector (1×, 4×, 16×, 60×, where 60× is one sim-minute per real second), scrubber across the simulated period, and an "events of interest" filter that highlights interactions involving newly-launched products. A small minimap shows you where in the city the action is right now.

**View modes.** Three rendering modes selectable from the top bar:

The default *agent mode* shows individuals — best for atmosphere, debugging, and following a specific persona. *Heatmap mode* shows foot-traffic density across the grid — useful for spotting congestion, dead zones, and the geographic spread of a new product after launch. *Conversion mode* colours each establishment by its conversion rate today, with a per-product overlay that highlights stores converting well on a launched SKU.

**Tech stack.** Frontend: React + deck.gl + Tailwind for the side panels. Backend: FastAPI with WebSocket endpoints publishing typed-array payloads — a `Float32Array` of agent positions and a `Uint8Array` of activity codes, ~5 bytes per agent per frame. At 1M agents on 5-minute deltas that's ~5 MB per frame, fine over a local-network or in-process WebSocket. Replay reads back the event Parquet log and synthesises the same delta stream. The whole frontend ships as a single static bundle served from the simulator's FastAPI process during local development — open `http://localhost:8000/view`, the simulation is alive on the right side of your screen.

**Phase 0 sizing.** On the M4 Pro, 1k agents render at well over 120 fps in a Chrome window alongside the running simulator with negligible GPU contention — deck.gl uses the same Metal pipeline as the model but the load is tiny. You can comfortably keep the viewer open during all Phase 0/1 runs. At Phase 2/3 the viewer typically runs on a separate machine pointing at the simulator's WebSocket endpoint over the network.

**What does NOT belong in the visual.** Real maps, real roads, real buildings — this is a synthetic city; a stylised grid is faster, clearer, and avoids a long detour into GIS. Path-animation between cells (interpolating each agent's exact route every frame) — teleport-and-tint at each delta is sufficient, looks fine at city scale, and keeps the GPU happy at 1M agents. Statistics that already live in the report — the live view is for *atmosphere and debugging*, not for analysis; keep the analytical heavy-lifting in the report so the live view stays uncluttered.

A reasonable build order: a static grid + zoning render in week 1, agent dots + activity colours and the WebSocket stream in week 2, side panels and the day-night overlay in week 3, mode-switching and event highlights in week 4. By the end of Phase 0 you have a viewer good enough to demo and good enough to debug with.

---

## 17. Validation and calibration

A simulator is only useful if it predicts. Three calibration loops are non-negotiable.

The first is **macro calibration**. The aggregate spend distribution across the 8 need buckets, by income decile, should match published consumer expenditure surveys for the city profile chosen. If the simulator's median household spends 12% on groceries when real data says 8%, the need-urgency parameters need retuning. We ship a calibration harness that compares simulated marginals against reference tables and reports the gap.

The second is **micro calibration**. We ship a test set of 50–100 historical product launches with known outcomes (this fragrance flopped in this segment; that snack cracked into Gen-Z). The simulator runs each launch on a city profile that resembles the actual market, and we score predicted vs. actual. This is the real measure of whether the thing works.

The third is **dialogue audit**. A human reviews a stratified sample of dialogues per run and rates plausibility on a rubric (does the buyer behave persona-consistently? does the seller stay in character? do objections feel real?). Failure modes — persona collapse, sycophancy, off-topic drift — get caught here and fixed in prompt templates.

Without these loops the simulator is theatre.

---

## 18. Roadmap

**Phase 0, weeks 1–2.** Stand up the persona generator, world grid, schedule planner, interaction runner, outcome extractor, the OpenAI-compatible local-LLM gateway (Ollama 8B + 3B), and the first cut of the visual interface (grid + agent dots + WebSocket stream + day-night overlay). Run 1k agents for 1 simulated day on the M4 Pro. Hand-audit 100 dialogues for plausibility.

**Phase 1, weeks 3–6.** Scale to 10k agents and 1 simulated week. Implement the product-introduction mechanic and the exposure stream. Run a synthetic launch end-to-end and produce the standard report. Begin shipping the calibration harness.

**Phase 2, months 2–3.** Scale to 100k. Stand up Ray. Train the distillation model on Phase-0/1 dialogue corpus. Switch fidelity policy to "LLM for launch + 5% sample." Add competitive-dynamics view. Add macro calibration as a CI gate.

**Phase 3, months 4–6.** Scale to 1M. Move to distributed event log. Production reporting frontend. Run the historical-launch validation suite and publish accuracy. Open the system for product-team self-service runs.

---

## 19. Risks and open questions

**Validity is the dominant risk.** A 1M-agent simulation that has not been calibrated against real launches is a confident-sounding hallucination. Phases must be gated by validation, not by feature checklists.

**Persona collapse is the dominant LLM risk.** Without careful prompt design, the buyer model defaults to a generic "reasonable shopper" voice that hides segment differences. Mitigation: persona-card prompt templates with strong specificity, dialogue audits, and adversarial diversity tests in CI.

**Cost discipline is non-trivial.** The fidelity policy must be enforced by a token-budget governor; otherwise a long-running sim quietly burns through the budget.

**Open question on real-world data.** The current design uses synthetic populations. Real census data improves micro-realism but introduces region specificity and licensing. Defer to Phase 2.

**Open question on multi-day persistence.** Across simulated weeks, do agents *learn* — update brand affinities based on regret, drift in tastes, churn relationships? The design supports it (state is persisted), but the update rules need a separate spec.

**Open question on regulatory/ethical posture.** A tool that predicts which personas to target with which pitches has clear potential for misuse. Worth thinking about an internal use policy before opening it to outside customers.

---

## 20. Decisions captured from this conversation

- **Deliverable for now:** architecture and design doc.
- **Dialogue model:** all interactions LLM-driven (with sampling/distillation as a planned scaling lever, per §14).
- **Initial prototype scale:** 1k agents, 1 simulated day.
- **Population source:** synthetic and parameterised.
- **Inference target:** local-first on MacBook M4 Pro 24 GB / 20-core GPU; 8B-class model (Llama 3.1 8B or equivalent) as default, 3B for routine tier, behind an OpenAI-compatible gateway so any tier can later swap to a 70B local box or a cloud API.
- **Visual interface:** browser-based, deck.gl WebGL rendering, top-down stylised grid, agent dots colour-coded by activity, vehicle sprites, full day-night cycle with simulated sunrise/sunset, click-through persona and establishment panels, three view modes (agent / heatmap / conversion), full replay from the event log.

Open items for the next round: city profile (US, India, generic?), brand catalogue scope, whether to model government/regulatory friction, multi-day learning rules, validation set sourcing, and the exact model + quant version once the project starts (model landscape moves faster than this doc).
