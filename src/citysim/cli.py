"""Command-line interface for Sim-city."""

from __future__ import annotations

import logging

import typer
import uvicorn

app = typer.Typer(help="Sim-city — synthetic city simulator.")


@app.command()
def serve(
    host: str = "127.0.0.1",
    port: int = 8000,
    n_agents: int = 1000,
    grid_size: int = 60,
    seed: int = 42,
    log_level: str = "info",
) -> None:
    """Run the simulator HTTP/WebSocket server."""
    logging.basicConfig(level=log_level.upper())
    # We construct the app lazily through a factory call so flags reach build_sim.
    # uvicorn requires a path or callable. Using factory mode with a wrapper.
    from citysim.server.app import create_app

    application = create_app(n_agents=n_agents, grid_size=grid_size, seed=seed)
    uvicorn.run(application, host=host, port=port, log_level=log_level)


@app.command()
def info() -> None:
    """Print the build version."""
    from citysim import __version__

    typer.echo(f"citysim {__version__}")


if __name__ == "__main__":
    app()
