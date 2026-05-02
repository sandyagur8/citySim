"""Command-line interface for Sim-city."""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import json
from pathlib import Path

import typer
import uvicorn

app = typer.Typer(help="Sim-city — synthetic city simulator.")


@app.command()
def serve(
    host: str = "127.0.0.1",
    port: int = 8000,
    n_agents: int = 100,
    grid_size: int = 80,
    seed: int = 42,
    max_establishments_per_kind: int = 5,
    log_level: str = "info",
    auto_dialogue: bool = True,
) -> None:
    """Run the simulator HTTP/WebSocket server.

    First boot generates personas into ~/.citysim/citysim.db (10k rows,
    a few seconds). Subsequent boots reuse the stored personas if the
    world signature (n_agents/seed/grid_size) matches.

    Auto-dialogue is on by default — a background worker fires one
    buyer-seller dialogue at a time through the local LLM and appends
    the result to the JSONL event log. At day rollover the simulator
    prints a summary to stdout. Disable with ``--no-auto-dialogue``.
    """
    logging.basicConfig(level=log_level.upper())
    from citysim.server.app import create_app

    application = create_app(
        
        n_agents=n_agents,
       
        grid_size=grid_size,
       
        seed=seed,
        auto_dialogue=auto_dialogue,
        max_establishments_per_kind=max_establishments_per_kind,
    )
    uvicorn.run(application, host=host, port=port, log_level=log_level)


@app.command()
def info() -> None:
    """Print the build version + storage status."""
    from citysim import __version__
    from citysim.store import PersonaStore, default_db_path

    typer.echo(f"citysim {__version__}")
    db = default_db_path()
    if db.exists():
        store = PersonaStore(db)
        typer.echo(f"DB: {db}")
        typer.echo(f"Personas stored: {store.count():,}")
        sig = store.get_meta("world_signature")
        if sig:
            typer.echo(f"World signature: {sig}")
    else:
        typer.echo(f"DB: {db} (not yet created — run `citysim serve` once)")


@app.command(name="regen-personas")
def regen_personas(
    n_agents: int = 10000,
    grid_size: int = 150,
    seed: int = 42,
) -> None:
    """Wipe ~/.citysim/citysim.db and regenerate personas from scratch."""
    from citysim.store import PersonaStore
    from citysim.world.establishments import place_establishments
    from citysim.world.grid import generate_grid
    from citysim.world.personas import load_or_generate_personas

    store = PersonaStore()
    grid = generate_grid(size=grid_size, seed=seed)
    establishments = place_establishments(grid, seed=seed)
    personas = load_or_generate_personas(
        grid,
        establishments,
        n=n_agents,
        seed=seed,
        store=store,
        force_regenerate=True,
    )
    typer.echo(f"Generated {len(personas):,} personas → {store.path}")


@app.command(name="show-persona")
def show_persona(agent_id: str) -> None:
    """Print one persona's full record (handy for sanity-checking dialogue)."""
    from citysim.store import PersonaStore

    store = PersonaStore()
    row = store.get(agent_id)
    if not row:
        typer.echo(f"No persona with id {agent_id!r}")
        raise typer.Exit(1)
    typer.echo(f"--- {row.agent_id} ---")
    typer.echo(f"  age={row.age} gender={row.gender} edu={row.education}")
    typer.echo(f"  occupation={row.occupation} income={row.income_band}")
    typer.echo(f"  household={row.household_id} role={row.household_role}")
    typer.echo(f"  home=({row.home_x},{row.home_y}) work=({row.work_x},{row.work_y})")
    typer.echo(f"  ens={row.ens_name} wallet={row.wallet_address} ens_status={row.ens_status}")
    typer.echo(f"  axl_key={row.axl_key}")
    typer.echo(f"  prefs={row.prefs}")
    typer.echo(f"  needs={row.needs}")
    typer.echo("")
    typer.echo(f"  card: {row.card_text}")


@app.command(name="backfill-wallets")
def backfill_wallets(
    account_group: int = 0,
    dry_run: bool = False,
) -> None:
    """Backfill deterministic HD wallet addresses for all personas in DB."""
    import os

    from citysim.store import PersonaStore
    from citysim.web3.wallets import derive_wallet_address

    mnemonic = os.environ.get("CITYSIM_WALLET_MNEMONIC") or os.environ.get("MNEMONIC")
    if not mnemonic:
        typer.echo("Missing mnemonic. Set CITYSIM_WALLET_MNEMONIC or MNEMONIC.")
        raise typer.Exit(1)

    store = PersonaStore()
    rows = store.all()
    if not rows:
        typer.echo("No personas found in DB.")
        return

    updated = 0
    for row in rows:
        try:
            idx = int(row.agent_id[1:])
        except ValueError:
            continue
        addr = derive_wallet_address(mnemonic, idx, account_group=account_group)
        if row.wallet_address == addr:
            continue
        row.wallet_address = addr
        updated += 1

    if dry_run:
        typer.echo(f"[dry-run] would update {updated} persona wallet addresses")
        return

    store.insert_many(rows)
    typer.echo(f"Updated wallet addresses for {updated} personas")


@app.command(name="backfill-axl-keys")
def backfill_axl_keys(
    dry_run: bool = False,
) -> None:
    """Backfill deterministic placeholder AXL keys for existing personas."""
    import hashlib
    from citysim.store import PersonaStore

    store = PersonaStore()
    rows = store.all()
    updated = 0
    for row in rows:
        desired = hashlib.sha256(f"axl:{row.agent_id}".encode("utf-8")).hexdigest()
        if row.axl_key == desired:
            continue
        row.axl_key = desired
        updated += 1
    if dry_run:
        typer.echo(f"[dry-run] would update {updated} axl_key fields")
        return
    store.insert_many(rows)
    typer.echo(f"Updated axl_key for {updated} personas")


@app.command(name="run-dialogue")
def run_dialogue_cmd(
    buyer_id: str | None = None,
    store_id: str | None = None,
    n_agents: int = 10000,
    grid_size: int = 150,
    seed: int = 42,
    max_turns: int = 6,
    no_extract: bool = False,
) -> None:
    """Run one buyer-seller dialogue end-to-end and print the transcript.

    Picks a random adult buyer and a random shoppable establishment if not
    specified. Streams turns to stdout as they're generated by the local
    LLM, then runs structured-outcome extraction (audit tier, falls back
    to rule-based if no OpenAI key).

    Examples:
      citysim run-dialogue
      citysim run-dialogue --buyer-id a000042
      citysim run-dialogue --store-id e0007 --max-turns 8
    """
    import random as _random

    from citysim.interaction import (
        DialogueTurn,
        find_employee,
        pick_random_buyer,
        pick_random_store,
        run_dialogue,
    )
    from citysim.interaction.transport import AxlTransport, LocalTransport
    from citysim.server.sim import build_sim
    from citysim.store import EventLog

    typer.echo("Loading world...")
    sim = build_sim(n_agents=n_agents, grid_size=grid_size, seed=seed)

    rng = _random.Random()

    if buyer_id:
        buyer = sim.persona_by_id.get(buyer_id)
        if buyer is None:
            typer.echo(f"No persona with id {buyer_id!r}")
            raise typer.Exit(1)
    else:
        buyer = pick_random_buyer(sim.personas, rng)

    if store_id:
        store = next((e for e in sim.establishments if e.id == store_id), None)
        if store is None:
            typer.echo(f"No establishment with id {store_id!r}")
            raise typer.Exit(1)
        seller = find_employee(store, sim.personas)
        if seller is None:
            typer.echo(f"Establishment {store_id!r} has no employees in this world")
            raise typer.Exit(1)
    else:
        picked = pick_random_store(sim.establishments, sim.personas, rng)
        if picked is None:
            typer.echo("No shoppable establishment with employees found.")
            raise typer.Exit(1)
        store, seller = picked

    typer.echo("")
    typer.echo(
        f"Buyer:  {buyer.agent_id} — {buyer.age} {buyer.gender} {buyer.occupation} ({buyer.income_band})"
    )
    typer.echo(f"        {buyer.card_text}")
    typer.echo(f"Seller: {seller.agent_id} — {seller.occupation} at {store.kind.value}")
    typer.echo(f"        {seller.card_text}")
    typer.echo("")
    typer.echo(f"Running dialogue (≤{max_turns} turns) on local Llama...")
    typer.echo("")

    def _print_turn(turn: DialogueTurn) -> None:
        typer.echo(f"  {turn.speaker.upper()}: {turn.text}")

    log = EventLog()
    transport_kind = os.environ.get("CITYSIM_TRANSPORT", "local").lower()
    transport = AxlTransport.from_env() if transport_kind == "axl" else LocalTransport()
    result = run_dialogue(
        buyer,
        seller,
        store,
        max_turns=max_turns,
        extract_outcome=not no_extract,
        log_to=log,
        on_turn=_print_turn,
        transport=transport,
    )

    typer.echo("")
    typer.echo(f"Ended: {result.end_reason} after {result.duration_s:.1f}s")
    typer.echo(f"Outcome: {result.outcome}")
    typer.echo(f"Logged to {log.dir}")


@app.command(name="init-product")
def init_product_cmd() -> None:
    """Define the product to test in the city. Saves ~/.citysim/product.json.

    The simulator runs as a generic city sim until a product brief is set.
    Once set, ``citysim serve`` biases shop dialogues toward selling this
    product, the outcome extractor pulls richer signals (intrinsic
    motivator, winning phrase, objections), and the day summary produces
    product-aware sections.

    To reset, run ``citysim clear-product``.
    """
    from citysim.product import (
        AGE_BANDS,
        INCOME_BANDS,
        POSITIONING_OPTIONS,
        ProductBrief,
        TargetFilter,
        default_product_path,
        load_product,
        save_product,
    )
    from citysim.world.establishments import EstablishmentKind

    existing = load_product()
    if existing:
        typer.echo(f"A product brief already exists at {default_product_path()}:")
        typer.echo(f"  {existing.name} ({existing.category}, ${existing.price:.2f})")
        if not typer.confirm("Overwrite?", default=False):
            raise typer.Exit(0)

    typer.echo("")
    typer.echo("Define the product to test:")
    typer.echo("")
    name = typer.prompt("Product name").strip()

    # Category — only the customer-facing kinds
    shoppable = [
        EstablishmentKind.SUPERMARKET,
        EstablishmentKind.COFFEE_SHOP,
        EstablishmentKind.RESTAURANT,
        EstablishmentKind.PUB,
        EstablishmentKind.HARDWARE,
        EstablishmentKind.PHARMACY,
        EstablishmentKind.CLOTHING,
        EstablishmentKind.BANK,
    ]
    typer.echo("")
    typer.echo("Where is this product sold? Pick one:")
    for i, k in enumerate(shoppable, 1):
        typer.echo(f"  {i}. {k.value}")
    pick = typer.prompt("Number", type=int)
    if pick < 1 or pick > len(shoppable):
        typer.echo("Invalid choice.")
        raise typer.Exit(1)
    category = shoppable[pick - 1].value

    price = typer.prompt("Price (numeric)", type=float)
    short_description = typer.prompt("One-sentence pitch").strip()
    typer.echo("")
    typer.echo("Detailed description (paste a paragraph; finish with an empty line):")
    detailed_lines: list[str] = []
    while True:
        line = typer.prompt("", default="", show_default=False)
        if not line.strip():
            break
        detailed_lines.append(line)
    detailed_description = "\n".join(detailed_lines).strip()

    typer.echo("")
    target_audience = typer.prompt(
        "Target audience (free text, e.g. 'urban professionals 25-40 who care about sustainability')"
    ).strip()

    typer.echo("")
    typer.echo("Structured target filter (used for A/B sampling):")
    typer.echo("Age bands: " + ", ".join(b for b, _, _ in AGE_BANDS))
    age_raw = typer.prompt(
        "Pick one or more (comma-separated), or blank for all", default="", show_default=False
    )
    age_bands = [s.strip() for s in age_raw.split(",") if s.strip()]
    valid_age = {b for b, _, _ in AGE_BANDS}
    age_bands = [a for a in age_bands if a in valid_age]

    typer.echo("Income bands: " + ", ".join(INCOME_BANDS))
    inc_raw = typer.prompt(
        "Pick one or more (comma-separated), or blank for all", default="", show_default=False
    )
    income_bands = [s.strip() for s in inc_raw.split(",") if s.strip()]
    income_bands = [i for i in income_bands if i in INCOME_BANDS]

    occ_regex = (
        typer.prompt(
            "Occupation regex (case-insensitive, blank to skip)", default="", show_default=False
        ).strip()
        or None
    )

    typer.echo("")
    feats_raw = typer.prompt(
        "Key features (comma-separated, blank to skip)", default="", show_default=False
    )
    key_features = [s.strip() for s in feats_raw.split(",") if s.strip()]

    typer.echo("")
    typer.echo("Positioning: " + ", ".join(POSITIONING_OPTIONS))
    positioning = typer.prompt("Pick one", default="mainstream").strip()
    if positioning not in POSITIONING_OPTIONS:
        positioning = "mainstream"

    brief = ProductBrief(
        name=name,
        category=category,
        price=float(price),
        short_description=short_description,
        detailed_description=detailed_description,
        target_audience=target_audience,
        target=TargetFilter(
            age_bands=age_bands,
            income_bands=income_bands,
            occupation_regex=occ_regex,
        ),
        key_features=key_features,
        positioning=positioning,
    )
    path = save_product(brief)
    typer.echo("")
    typer.echo(f"Saved product brief to {path}")
    typer.echo(f"  {brief.name} — sold at {brief.category}, ${brief.price:.2f}")
    typer.echo(
        f"  Target: age={brief.target.age_bands or 'any'}, "
        f"income={brief.target.income_bands or 'any'}"
    )
    typer.echo("")
    typer.echo("Next: `citysim serve` — the worker will start running product dialogues.")


@app.command(name="show-product")
def show_product_cmd() -> None:
    """Print the currently saved product brief."""
    from citysim.product import default_product_path, load_product

    brief = load_product()
    if not brief:
        typer.echo(f"No product brief at {default_product_path()}.")
        typer.echo("Run `citysim init-product` to create one.")
        raise typer.Exit(1)
    typer.echo(f"--- {brief.name} ---")
    typer.echo(f"  category    : {brief.category}")
    typer.echo(f"  price       : {brief.price:.2f} {brief.currency}")
    typer.echo(f"  positioning : {brief.positioning}")
    typer.echo(f"  pitch       : {brief.short_description}")
    if brief.key_features:
        typer.echo(f"  features    : {', '.join(brief.key_features)}")
    typer.echo(f"  target_audience : {brief.target_audience}")
    typer.echo(f"  target.ages     : {brief.target.age_bands or 'any'}")
    typer.echo(f"  target.income   : {brief.target.income_bands or 'any'}")
    typer.echo(f"  target.regex    : {brief.target.occupation_regex or 'none'}")
    if brief.detailed_description:
        typer.echo("")
        typer.echo("Detailed description:")
        typer.echo(brief.detailed_description)


@app.command(name="clear-product")
def clear_product_cmd() -> None:
    """Remove the saved product brief — simulator returns to generic mode."""
    from citysim.product import clear_product, default_product_path

    if clear_product():
        typer.echo(f"Removed {default_product_path()}")
    else:
        typer.echo("No product brief to clear.")


@app.command()
def summary(day: int) -> None:
    """Print the activity summary for one simulated day.

    Reads ~/.citysim/events/events-day{DAY:04d}.jsonl, aggregates the
    dialogues into counts / conversion / breakdowns / top factors, and
    prints a terminal-friendly report. The same render the simulator
    emits at day rollover — this command lets you re-inspect any
    earlier day at any time.

    Examples:
      citysim summary 120
      citysim summary 121
    """
    from citysim.reporting import format_summary, summarize_day
    from citysim.store import EventLog, PersonaStore

    log = EventLog()
    store = PersonaStore()
    s = summarize_day(day, event_log=log, persona_store=store)
    typer.echo(format_summary(s))
    if s.n_dialogues == 0:
        typer.echo(f"(Looked in {log.dir / f'events-day{day:04d}.jsonl'})")


@app.command(name="llm-test")
def llm_test(
    prompt: str = "Say hello in five words.",
    provider: str | None = None,
    model: str | None = None,
    tier: str = "agent",
) -> None:
    """Smoke-test the LLM gateway end-to-end.

    Default tier is ``agent`` — routed to the local Ollama model. Pass
    ``--tier audit`` to hit OpenAI, or ``--provider openai`` to override
    explicitly.
    """
    from citysim.llm import LLMMessage, get_gateway

    gateway = get_gateway(tier=tier, provider_override=provider, model_override=model)
    typer.echo(f"Tier: {tier}  Provider: {gateway.provider}  Model: {gateway.model}")
    resp = gateway.chat([LLMMessage(role="user", content=prompt)], max_tokens=64)
    typer.echo(f"Reply: {resp.text.strip()}")
    if resp.usage:
        typer.echo(f"Tokens: {resp.usage}")


if __name__ == "__main__":
    app()


@app.command(name="mint-ens-subnames")
def mint_ens_subnames(
    limit: int = 20,
    script_path: str = "../axl_integration/mint_ens_subnames.ts",
    dry_run: bool = False,
) -> None:
    """Mint ENS subnames for pending personas and update ens_status/tx hash."""
    from citysim.store import PersonaStore

    store = PersonaStore()
    rows = store.all()
    pending = [r for r in rows if (r.ens_status or "pending") != "minted" and r.ens_name]
    jobs = []
    for r in pending[: max(0, limit)]:
        jobs.append(
            {
                "agent_id": r.agent_id,
                "ens_name": r.ens_name,
                "text_value": r.wallet_address or r.agent_id,
            }
        )

    if not jobs:
        typer.echo("No pending personas with ens_name found.")
        return
    if dry_run:
        typer.echo(f"[dry-run] would mint {len(jobs)} subnames")
        return

    script_abs = Path(script_path).resolve()
    if not script_abs.exists():
        typer.echo(f"ENS mint script not found: {script_abs}")
        raise typer.Exit(1)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
        json.dump(jobs, tmp)
        tmp.flush()
        tmp_path = tmp.name
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as out:
        out_path = out.name

    proc = subprocess.run(
        ["npx", "tsx", str(script_abs), tmp_path, out_path],
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        typer.echo("ENS mint worker failed:")
        raise typer.Exit(1)

    try:
        with open(out_path, encoding="utf-8") as f:
            results = json.load(f)
    except Exception:
        typer.echo("Could not parse ENS worker output.")
        raise typer.Exit(1)

    by_id = {r.agent_id: r for r in rows}
    minted = 0
    failed = 0
    for res in results:
        row = by_id.get(res.get("agent_id"))
        if not row:
            continue
        status = res.get("status")
        if status == "minted":
            row.ens_status = "minted"
            row.ens_tx_hash = res.get("tx_hash")
            minted += 1
        else:
            row.ens_status = "failed"
            failed += 1
    store.insert_many(rows)
    typer.echo(f"ENS mint done. minted={minted} failed={failed}")


@app.command(name="push-axl-keys-to-ens")
def push_axl_keys_to_ens(
    limit: int = 20,
    script_path: str = "../axl_integration/set_ens_text_batch.ts",
    dry_run: bool = False,
) -> None:
    """Push persona axl_key values into ENS text record axl_key."""
    from citysim.store import PersonaStore

    store = PersonaStore()
    rows = store.all()
    targets = [
        r
        for r in rows
        if r.ens_status == "minted" and r.ens_name and r.axl_key
    ][: max(0, limit)]
    if not targets:
        typer.echo("No minted personas with axl_key found.")
        return
    if dry_run:
        typer.echo(f"[dry-run] would push {len(targets)} ENS text records")
        return

    script_abs = Path(script_path).resolve()
    if not script_abs.exists():
        typer.echo(f"ENS text batch script not found: {script_abs}")
        raise typer.Exit(1)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
        jobs = [{"agent_id": r.agent_id, "ens_name": r.ens_name, "text_value": r.axl_key} for r in targets]
        json.dump(jobs, tmp)
        tmp.flush()
        tmp_path = tmp.name
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as out:
        out_path = out.name

    proc = subprocess.run(
        ["npx", "tsx", str(script_abs), tmp_path, out_path],
        text=True,
        check=False,
    )
    typer.echo(f"Submitted {len(targets)} ENS text updates. Waiting for worker...")
    if proc.returncode != 0:
        typer.echo("ENS text push worker failed.")
        raise typer.Exit(1)

    with open(out_path, encoding="utf-8") as f:
        result = json.load(f)
    ok = sum(1 for r in result if r.get("status") == "ok")
    failed = len(result) - ok
    typer.echo(f"ENS text push done. ok={ok} failed={failed}")


@app.command(name="benchmark")
def benchmark_cmd(
    n_agents: int = 1000,
    grid_size: int = 80,
    seed: int = 42,
    runs: int = 50,
    max_turns: int = 6,
    transport: str = "local",
    transport_required: bool = False,
    no_extract: bool = True,
) -> None:
    """Run Phase 8 baseline benchmark script."""
    script = Path(__file__).resolve().parents[2] / "scripts" / "phase8_benchmark.py"
    if not script.exists():
        typer.echo(f"Benchmark script missing: {script}")
        raise typer.Exit(1)

    cmd = [
        "python",
        str(script),
        "--n-agents",
        str(n_agents),
        "--grid-size",
        str(grid_size),
        "--seed",
        str(seed),
        "--runs",
        str(runs),
        "--max-turns",
        str(max_turns),
        "--transport",
        transport,
    ]
    if transport_required:
        cmd.append("--transport-required")
    if no_extract:
        cmd.append("--no-extract")

    proc = subprocess.run(cmd, check=False, text=True)
    if proc.returncode != 0:
        raise typer.Exit(proc.returncode)


@app.command(name="preflight")
def preflight_cmd(
    base: str = "http://127.0.0.1:8000",
    ens: str = "a000000.simcity-7890.eth",
) -> None:
    """Run Phase 9 preflight validator against running stack."""
    script = Path(__file__).resolve().parents[2] / "scripts" / "phase9_preflight.py"
    if not script.exists():
        typer.echo(f"Preflight script missing: {script}")
        raise typer.Exit(1)

    proc = subprocess.run(
        ["python", str(script), "--base", base, "--ens", ens],
        check=False,
        text=True,
    )
    if proc.returncode != 0:
        raise typer.Exit(proc.returncode)
