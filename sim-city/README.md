# Sim-city

A synthetic city simulator for product testing. Up to 1M LLM-backed agents living recognisable urban lives — they wake, work, shop, eat, save, splurge, regret — so a product team can drop a new SKU into the world and watch how it spreads, who buys it, what they say to the salesperson, and which segments resist.

In the larger protocol, Sim-city is the **agent population + behaviour engine**. It owns:

- The synthetic population (10k → 1M agents) with realistic demographics, households, jobs, preferences, needs, schedules.
- The buyer/seller dialogue runtime (local Llama 3.1 8B by default, OpenAI for audit/extraction).
- The structured event log every dialogue/exposure/outcome lands in.
- The deck.gl viewer that renders the city in real time.

What Sim-city does **not** own (and what the partner's web3 stack contributes):

- ENS subdomain registration per agent.
- HD-derived wallets and on-chain settlement.
- AXL transport on Gensyn for inter-agent intentions/messages.

The integration seams are documented in [§10 Web3 integration plan](#10-web3-integration-plan) below — every place the web3 layer plugs in is called out with a file path.

The full design (1M-scale architecture, validation strategy, cost reality, etc.) is in [`docs/design.md`](docs/design.md).

## 1. Architecture at a glance

```
                ┌──────────────────────────────────────────┐
                │          deck.gl viewer (React)          │
                │  3D city, day/night cycle, agent dots    │
                └────────────────────▲─────────────────────┘
                                     │  WebSocket: agent deltas
                                     │  every 5 sim-minutes
┌────────────────────────────────────┴─────────────────────────────────┐
│                   FastAPI server  (src/citysim/server)               │
│  • SimState: grid, establishments, personas, schedules               │
│  • Tick loop drives agent positions; broadcasts deltas               │
└────────┬──────────────────┬────────────────────────────┬─────────────┘
         │                  │                            │
         │                  │                            │
         ▼                  ▼                            ▼
┌──────────────────┐ ┌──────────────────┐  ┌──────────────────────────┐
│  PersonaStore    │ │  EventLog        │  │  Interaction runner      │
│  SQLite (WAL)    │ │  JSONL per day   │  │  (src/citysim/           │
│  ~/.citysim/     │ │  ~/.citysim/     │  │   interaction)           │
│  citysim.db      │ │  events/         │  │                          │
└──────────────────┘ └──────────────────┘  │  buyer + seller chat     │
                                            │  through LLM gateway     │
                                            └──────────┬───────────────┘
                                                       │
                                                       ▼
                                       ┌────────────────────────────────┐
                                       │  LLM gateway (tier-routed)     │
                                       │  • agent  → Ollama (local)     │
                                       │  • audit  → OpenAI (extract)   │
                                       └────────────────────────────────┘
```

Every layer has a clean seam. The web3 layer attaches at four places:

- `Persona` record → carries `ens_name` and `wallet_address`.
- Interaction runner → swaps the in-process buyer/seller pipe for an AXL transport.
- Outcome handler → emits an on-chain settlement transaction when `purchased=True`.
- Event log → consumed by the protocol's indexer for receipts.

## 2. Prerequisites

| Thing | Version | Purpose |
|---|---|---|
| Python | 3.11+ | Backend, CLI, persona pipeline |
| Node | 20+ | Viewer build |
| pnpm | 9+ | Viewer package manager (`npm i -g pnpm`) |
| Ollama | latest | Runs the local Llama 3.1 8B for agent dialogue |
| OpenAI API key | optional | For audit-tier structured extraction (rule-based fallback if absent) |

Disk: budget ~6 GB for the Llama model + 200 MB for the persona DB at 10k agents (1.2 GB at 1M).

## 3. Setup

### 3.1 Backend

```bash
git clone <citysim-repo-url>
cd sim-city                             # (or wherever the folder lives in your repo)
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

### 3.2 Local LLM (Ollama + Llama 3.1 8B)

```bash
bash scripts/setup-local-llm.sh         # installs Ollama, pulls llama3.1:8b, smoke-tests
```

The script:

1. Installs Ollama (Homebrew on macOS, install.sh on Linux).
2. Starts the daemon if it isn't already up at `http://localhost:11434`.
3. Pulls `llama3.1:8b` (~4.7 GB).
4. Hits the OpenAI-compatible endpoint with a five-word smoke test.

To use a different model:

```bash
bash scripts/setup-local-llm.sh qwen2.5:7b
export OLLAMA_MODEL=qwen2.5:7b
```

### 3.3 OpenAI key (optional, for audit tier)

The `agent` tier (every dialogue turn) runs locally on Ollama — **no key needed for normal operation**. The `audit` tier extracts structured outcomes (`purchased`, `decisive_factor`, `regret_signal`) from transcripts and uses OpenAI for stricter JSON-mode parsing.

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini    # default; cheapest sensible choice
```

If `OPENAI_API_KEY` is missing, the runner falls back to a rule-based extractor (`purchased = (end_reason == "buy")`, decisive_factor stubbed). Transcripts are unaffected and structured outcomes can be backfilled later by replaying the event log.

Verify both tiers:

```bash
citysim llm-test --tier agent      # routes to local Ollama
citysim llm-test --tier audit      # routes to OpenAI
```

### 3.4 Viewer

```bash
cd viewer
pnpm install
pnpm dev                            # opens http://localhost:5173
```

## 4. First run

In one terminal:

```bash
citysim serve
```

First boot generates 10k personas (a few seconds) into `~/.citysim/citysim.db`. Subsequent boots reuse them as long as the **world signature** matches (`n=10000;seed=42;grid=150`). Change any of those and personas regenerate from scratch.

In another terminal:

```bash
cd viewer && pnpm dev
```

Open http://localhost:5173. You'll see a stylised 3D city, ~10k agent dots and cars moving through schedules, day/night lighting that shifts personas from muted day-palette to neon at night, and time controls (1×, 4×, 16×, 60×).

Sanity-check storage:

```bash
citysim info
# citysim 0.1.0
# DB: /Users/you/.citysim/citysim.db
# Personas stored: 10,000
# World signature: n=10000;seed=42;grid=150
```

## 5. Working with individual agents

This is how you debug or audit a single persona end-to-end.

### 5.1 Inspect one persona

```bash
citysim show-persona a000042
# --- a000042 ---
#   age=34 gender=female edu=bachelors
#   occupation=barista income=low
#   household=h001234 role=primary
#   home=(72,118) work=(24,8)
#   prefs={'novelty_seeking': 0.74, 'price_sensitivity': 0.81, ...}
#   needs={'food': 0.7, 'leisure': 0.5, ...}
#
#   card: 34-year-old woman, lives in unit ... [200-word prose card]
```

The `card_text` is the human-readable summary fed into the LLM as system prompt context. It's templated from the structured fields — no LLM call to generate.

### 5.2 Regenerate the population

```bash
citysim regen-personas --n-agents 10000 --seed 42 --grid-size 150
```

Wipes the DB and rebuilds. Use this when you change the persona schema or want a different seed.

### 5.3 Run a single dialogue end-to-end

```bash
citysim run-dialogue
```

Picks a random adult buyer + a random shoppable establishment that has at least one employee (coffee shop, supermarket, restaurant, pub, hardware, pharmacy, clothing, bank). Streams turns to stdout as the local Llama generates them, then runs structured-outcome extraction.

Pin one or both sides:

```bash
citysim run-dialogue --buyer-id a000042 --store-id e0007 --max-turns 8
citysim run-dialogue --no-extract           # skip OpenAI extraction; stay fully local
```

Output looks like:

```
Buyer:  a000042 — 34 female barista (low)
Seller: a009114 — bartender at pub

  SELLER: Evening. What'll it be?
  BUYER: Pint of whatever's cheapest, please. Long shift.
  SELLER: House lager it is. Want a bag of crisps with it?
  BUYER: Go on then. [BUY]

Ended: buy after 4.2s
Outcome: {'purchased': True, 'product': 'house lager + crisps', ...}
Logged to /Users/you/.citysim/events/
```

Tagged tokens (`[BUY]` / `[LEAVE]`) end the dialogue early. Otherwise it stops at `--max-turns` (default 6).

### 5.4 Smoke-test the LLM gateways directly

```bash
citysim llm-test --tier agent --prompt "Say hi in five words."
citysim llm-test --tier audit --prompt "Return JSON: {\"ok\": true}"
```

Useful when something feels off — confirms the Ollama daemon is reachable and the OpenAI key works before you hunt for bugs in the dialogue layer.

## 6. Running the full simulation

`citysim serve` runs the world in real-time inside the FastAPI app and attaches the viewer for visualisation. A background **dialogue worker** is on by default — it continuously picks a buyer / shoppable-establishment / employee triple from the live world and runs a buyer-seller dialogue through the local LLM, appending the structured outcome to the JSONL event log. At day rollover (every simulated 24h) the simulator prints a per-day activity summary to stdout.

The simulator runs in two modes:

- **Generic city sim** (no product brief loaded) — random buyer, random shoppable establishment, generic shop chatter.
- **Product test mode** — once you run `citysim init-product`, the worker biases shop conversations toward selling that specific product, captures intrinsic motivators / winning phrases / objections, and produces product-aware summaries with A/B buyer sampling. See [§7 Product testing workflow](#7-product-testing-workflow) for the full loop.

```bash
# terminal 1 — simulator + viewer backend (auto-dialogue on)
citysim serve --n-agents 10000 --seed 42

# terminal 2 — viewer
cd viewer && pnpm dev
```

That's it — leave the simulator running and dialogues will accumulate in `~/.citysim/events/events-day{NNNN}.jsonl`. At each day rollover you'll see a summary printed in terminal 1.

Re-print any earlier day's summary at any time with:

```bash
citysim summary 120
```

### 6.1 Tuning the dialogue worker

Three env vars and one CLI flag control the cadence:

| Var / flag                    | Default | Effect                                                              |
|-------------------------------|---------|---------------------------------------------------------------------|
| `CITYSIM_DIALOGUE_PAUSE_S`    | 5.0     | Real-second sleep between dialogues                                 |
| `CITYSIM_DIALOGUE_MAX_TURNS`  | 6       | Hard cap on turn count per dialogue                                 |
| `CITYSIM_BASELINE_RATIO`      | 0.25    | Fraction of dialogues that hit non-product shops (control baseline) |
| `--no-auto-dialogue`          | off     | Disable the worker entirely (run manual dialogues only)             |

The actual cadence is dominated by how long the local model takes to generate each turn — typically 3-10 seconds for a 6-turn dialogue on an 8B-class model. At default settings expect dozens of dialogues per simulated day at 60x speed; fewer at higher sim speeds (the LLM, not the clock, becomes the bottleneck).

You can still trigger ad-hoc dialogues alongside the auto-worker:

```bash
citysim run-dialogue --buyer-id a000042 --store-id e0007
```

## 7. Product testing workflow

The product-test loop is the headline use case: define a product, run the simulator, read the daily summary, iterate.

### 7.1 Define the product

```bash
citysim init-product
```

Walks you through 8 prompts and saves `~/.citysim/product.json`:

- **Name** — e.g. "OatLatte+"
- **Category** — which establishment kind sells it (`coffee_shop`, `supermarket`, `restaurant`, `pub`, `hardware`, `pharmacy`, `clothing`, `bank`)
- **Price** — numeric, in your chosen currency
- **One-sentence pitch** — flows verbatim into the seller's prompt
- **Detailed description** — the full elevator pitch, paste a paragraph
- **Target audience** — free-text persona, e.g. "urban professionals 25-40 who care about sustainability"
- **Structured target filter** — age bands + income bands (+ optional occupation regex), used for A/B sampling
- **Key features** — comma-separated list (also flows into the seller prompt)
- **Positioning** — `premium` / `value` / `niche` / `mainstream`

Inspect it:

```bash
citysim show-product
```

Reset:

```bash
citysim clear-product
```

### 7.2 Run the simulator

```bash
citysim serve --n-agents 10000 --seed 42
```

The dialogue worker detects the product brief on startup (it logs `dialogue_worker: PRODUCT mode - 'OatLatte+' at coffee_shop, $5.50. Target: ages=['18-29','30-44'], income=['middle','upper_middle']`).

Each iteration it:

1. Decides whether this dialogue is **product** (∼75%) or **baseline-generic** (∼25%, controlled by `CITYSIM_BASELINE_RATIO`).
2. For product dialogues: alternates between **random** sampling (uniform across all 10k personas) and **targeted** sampling (only personas matching the brief's age/income/occupation filter).
3. Picks an establishment matching `product.category` (or any non-matching shoppable for baseline).
4. Runs the dialogue with a seller-prompt that includes the full product brief.
5. Calls the audit-tier extractor with the **product schema** — pulling `purchased`, `units`, `price_paid`, `decisive_factor`, `intrinsic_motivator`, `seller_winning_phrase` (verbatim quote), `objections_raised`, `price_sensitivity`, `target_fit`.

### 7.3 Read the daily summary

At every day rollover (every simulated 24h), the simulator prints a product-aware summary:

```
======================================================================
Day  120  -  'OatLatte+' product test
======================================================================
PRODUCT TEST
----------------------------------------------------------------------
Units sold              : 39 / 84 product interactions
Conversion (product)    : 46.4%
Revenue                 : 214.50
Avg price paid          : 5.50

A/B sampling (random vs targeted buyers):
  random      n=42   buy_rate= 33.3%
  targeted    n=42   buy_rate= 59.5%

Top intrinsic motivators (in conversions):
  health                    14
  novelty                   10
  social status              8
  identity                   5
  saving money               2

Top seller phrases that converted:
  (7x)  "It's locally sourced and the oats are climate-positive."
  (5x)  "We have a loyalty card — your fifth one's on us."
  (4x)  "Most people who try it switch from regular lattes."

Top objections (in non-conversions):
  too expensive             18
  not needed                11
  prefer competitor          6

Buyer demographics by age band:
  18-29       n=22   buy_rate= 59.1%
  30-44       n=31   buy_rate= 51.6%
  45-59       n=20   buy_rate= 35.0%
  60+         n=11   buy_rate= 18.2%

Most relevant personas (top 10):
  *[BUY] a004821  35F designer (middle)            -> health
  *[BUY] a009134  28M software engineer (upper_middle)  -> identity
   [BUY] a001247  44F nurse (middle)               -> convenience
  *[no ] a006781  31M teacher (low)                -> none
  ...
  (* = matched target audience filter)
----------------------------------------------------------------------
ALL ACTIVITY (product + baseline)
----------------------------------------------------------------------
Dialogues run        : 112
Purchases committed  : 51
Conversion rate      : 45.5%
Avg price paid       : 7.20
Total spend          : 367.20
...
======================================================================
```

The **A/B block** is the headline number for product validation: how does conversion among targeted buyers compare to the population baseline? A big gap means your target audience hypothesis is right; a small gap means the product appeals broadly (or your targeting is too narrow).

The **winning phrases** section is gold for marketing copy — those are the exact lines that converted simulated customers; they translate directly into ad copy and seller-training material.

The **top objections** section is your roadmap for product/positioning iteration.

### 7.4 Iterate

```bash
citysim clear-product
citysim init-product   # try a lower price, different positioning, broader target
citysim serve          # re-run for another sim day
citysim summary 121    # compare to day 120
```

Days are independent — each summary file at `~/.citysim/events/events-day{NNNN}.jsonl` is the raw record, and `citysim summary <day>` recomputes the report at any time. Re-running the simulator with the same seed reproduces the same population.

## 8. Inspecting state

### 8.1 Persona DB (SQLite)

```bash
sqlite3 ~/.citysim/citysim.db
sqlite> .schema personas
sqlite> SELECT occupation, COUNT(*) FROM personas GROUP BY occupation ORDER BY 2 DESC;
sqlite> SELECT income_band, AVG(age) FROM personas GROUP BY income_band;
```

Every persona row has indexed columns for `household_id`, `employer_id`, `occupation`, `income_band` — segment queries are cheap.

### 8.2 Event log (JSONL → DuckDB)

```bash
duckdb
D SELECT
    payload->>'establishment_kind' AS kind,
    payload->>'end_reason' AS ended,
    payload->'outcome'->>'decisive_factor' AS why,
    COUNT(*)
  FROM read_json_auto('~/.citysim/events/events-day*.jsonl')
  GROUP BY 1,2,3
  ORDER BY 4 DESC;
```

This is the schema the protocol's indexer should consume. Anything you want exported on-chain (purchase receipts, signed messages, settlement amounts) gets pulled from this log.

## 9. Repo layout

```
sim-city/
├── src/citysim/
│   ├── cli.py                     # typer commands (serve, info, run-dialogue, ...)
│   ├── store.py                   # SQLite PersonaStore + JSONL EventLog
│   ├── llm/
│   │   └── gateway.py             # provider-agnostic chat() + tier routing
│   ├── world/
│   │   ├── grid.py                # zoned city grid generator
│   │   ├── solar.py               # sunrise/sunset by lat + date
│   │   ├── establishments.py      # shops, schools, hospitals, parks, ...
│   │   ├── personas.py            # joint-conditional persona sampler
│   │   ├── agents.py              # legacy stub (kept for runtime Agent type)
│   │   └── schedule.py            # daily routine planner per agent
│   ├── interaction/
│   │   ├── runner.py              # buyer/seller dialogue loop
│   │   └── prompts.py             # system prompts + extraction template
│   └── server/
│       ├── app.py                 # FastAPI app factory
│       └── sim.py                 # SimState + tick loop + WebSocket broadcast
├── viewer/                        # React + Vite + deck.gl
├── scripts/
│   └── setup-local-llm.sh         # Ollama install + model pull + smoke
├── docs/design.md                 # full system design
├── tests/
└── pyproject.toml
```

## 10. Web3 integration plan

This is the section to read if you own the AXL/ENS/wallet stack. Sim-city's job ends at "produce a structured intention/outcome stream"; your job is to make those intentions real on-chain. Four concrete seams:

### 10.1 ENS subdomain per agent

Each persona gets a deterministic ENS subdomain, e.g. `a000042.simcity.eth`.

**Schema change** — add to `src/citysim/store.py` (`PERSONA_SCHEMA`) and `src/citysim/world/personas.py` (`Persona` dataclass + `_card_text` so it appears in the prose card):

```sql
ens_name        TEXT,
wallet_address  TEXT,
```

**Where to populate** — `src/citysim/world/personas.py::generate_personas` already loops over `range(n)` to mint `agent_id = f"a{i:06d}"`. Add right next to it:

```python
ens_name = f"{agent_id}.simcity.eth"     # deterministic, no on-chain call yet
```

**Registration** — call your ENS subdomain registrar at population-generation time. Two approaches:

- *Lazy*: register on first activity (when the agent first appears in a dialogue). Cheaper if not all agents are active.
- *Eager*: batch-register all 10k at population creation. Simpler reasoning.

The registrar call itself goes in a new `src/citysim/web3/ens.py` module. Add `register_subdomain(ens_name: str, owner_address: str) -> tx_hash` and call it from `generate_personas`.

### 10.2 HD wallet derivation

Reproducible wallets from a single mnemonic — agent index is the BIP-44 path index.

```
m/44'/60'/0'/0/<agent_index>
```

So `a000042` always derives the same address as long as the master mnemonic is the same. This means a fresh `regen-personas` rebuilds the same wallets — important for replay debugging.

**Where to wire it** — new file `src/citysim/web3/wallets.py`:

```python
def derive_wallet(mnemonic: str, agent_index: int) -> tuple[str, str]:
    """Returns (address, private_key). Use eth_account or web3.py."""
```

Master mnemonic comes from env var `CITYSIM_WALLET_MNEMONIC`. **Do not commit it.** For local dev, generate one and stash in `.env.local`. For the simulation farm, pull from the protocol's secret manager.

Populate `wallet_address` on the `Persona` row from `derive_wallet(...)[0]` inside `generate_personas`.

### 10.3 AXL transport on Gensyn

Right now `interaction/runner.py::run_dialogue` runs both sides in-process: one Python loop appends to two message histories and calls the LLM gateway directly for each turn. This is fast but bypasses the protocol entirely.

To make agent-to-agent communication go through AXL on Gensyn, introduce a `Transport` abstraction:

```python
# src/citysim/interaction/transport.py
class Transport(Protocol):
    def send(self, from_agent: Persona, to_agent: Persona, payload: dict) -> str:
        """Returns a message id / tx hash."""
    def receive(self, agent: Persona, timeout_s: float) -> dict | None:
        """Blocks until a message for `agent` arrives or timeout."""

class LocalTransport:    # current behaviour, in-process
    ...

class AxlTransport:      # signs the payload with the agent's wallet,
    ...                  # publishes to Gensyn via AXL, awaits the reply
```

Then `run_dialogue` takes a `transport: Transport = LocalTransport()` parameter. The dialogue loop becomes:

```python
transport.send(buyer, seller, {"role": "user", "text": buyer_text, "turn": n})
seller_text = transport.receive(seller, timeout_s=30).text
# ... etc
```

The LLM call still happens — it's just *each side's local LLM call inside their own process*. Two processes, AXL between them, identical transcript.

For the *simulation* (10k agents, all on one box), you'd run dialogues with `LocalTransport` for speed and `AxlTransport` for protocol-level correctness tests.

### 10.4 Settlement layer

When a dialogue ends with `purchased=True`, the buyer's wallet should pay the seller's wallet (or the establishment's treasury). Right now this is just a JSON field on the outcome.

Add `src/citysim/web3/settlement.py`:

```python
def settle_dialogue(result: DialogueResult) -> str | None:
    """If purchased, transfer price_paid from buyer wallet to seller's
    establishment wallet. Returns tx_hash or None."""
```

Call it from `interaction/runner.py::run_dialogue` immediately after `_extract_outcome`, behind a flag (`settle_on_chain: bool = False` to keep the local default fast). Append the `tx_hash` to the event log payload so the indexer can reconcile.

Establishments need wallets too — give each one a deterministic address derived from `establishment_id` under a different BIP-44 path (e.g. `m/44'/60'/1'/0/<i>`). Same approach as 9.2.

### 10.5 Where to wire it (summary)

| Concern | File | Hook |
|---|---|---|
| ENS name on persona | `src/citysim/world/personas.py` | `generate_personas` loop |
| ENS schema column | `src/citysim/store.py` | `PERSONA_SCHEMA` |
| Wallet derivation | `src/citysim/web3/wallets.py` *(new)* | called from `generate_personas` |
| ENS registration | `src/citysim/web3/ens.py` *(new)* | called from `generate_personas` |
| AXL transport | `src/citysim/interaction/transport.py` *(new)* | parameter to `run_dialogue` |
| Settlement | `src/citysim/web3/settlement.py` *(new)* | called from `run_dialogue` after extraction |
| Indexer source | `~/.citysim/events/*.jsonl` | already structured for read_json_auto |

The Sim-city codebase is set up so all four can ship as a `citysim.web3` subpackage that other modules import from. No core simulator code needs to know whether the protocol is live — flags + dependency injection keep the local-only path fast for development.

## 11. Development

Lint, format, type-check, test:

```bash
ruff check src tests
ruff format --check src tests
mypy src
pytest -q
```

CI runs the same on every push that touches `sim-city/**` — see `.github/workflows/sim-city-ci.yml` at the repo root.

Useful env vars:

| Var | Default | Purpose |
|---|---|---|
| `CITYSIM_HOME` | `~/.citysim` | Where the SQLite DB and event logs live |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Local LLM endpoint |
| `OLLAMA_MODEL` | `llama3.1:8b` | Local model tag |
| `OPENAI_API_KEY` | (unset) | Audit-tier extraction; falls back to rule-based if missing |
| `OPENAI_MODEL` | `gpt-4o-mini` | Audit model |
| `CITYSIM_LLM_PROVIDER_AGENT` | `ollama-openai` | Override agent-tier provider |
| `CITYSIM_LLM_PROVIDER_AUDIT` | `openai` | Override audit-tier provider |

## 12. Troubleshooting

**`zsh: command not found: citysim`** — venv not activated. `source .venv/bin/activate && pip install -e .`.

**`Connection refused` from Ollama** — daemon isn't running. Open the Ollama app from Applications (it auto-starts the daemon), or run `ollama serve` in another terminal. Verify with `curl http://localhost:11434/api/version`.

**Audit tier returns `_fallback: True`** — `OPENAI_API_KEY` not set or invalid. The runner switched to the rule-based outcome extractor. Set the key and re-run, or replay the event log later.

**Personas regenerate on every boot** — world signature changed. Check `citysim info` — the signature is `n=<n>;seed=<seed>;grid=<size>`. If you bumped any of these without meaning to, set them back; otherwise this is intentional.

**Viewer build fails on `pnpm install`** — make sure pnpm is v9+ and Node is v20+. `node -v && pnpm -v`.

## 13. Licence

Private project. Not for redistribution.
