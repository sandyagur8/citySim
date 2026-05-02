from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Protocol

import httpx

from citysim.world.personas import Persona


class Transport(Protocol):
    def send(self, from_agent: Persona, to_agent: Persona, payload: str) -> str:
        ...


@dataclass
class LocalTransport:
    def send(self, from_agent: Persona, to_agent: Persona, payload: str) -> str:
        return f"local:{from_agent.agent_id}->{to_agent.agent_id}:{len(payload)}"


@dataclass
class AxlTransport:
    node_a_port: int = 9002
    node_b_port: int = 9012
    timeout_s: float = 10.0

    @classmethod
    def from_env(cls) -> AxlTransport:
        return cls(
            node_a_port=int(os.environ.get("CITYSIM_AXL_NODE_A_PORT", "9002")),
            node_b_port=int(os.environ.get("CITYSIM_AXL_NODE_B_PORT", "9012")),
            timeout_s=float(os.environ.get("CITYSIM_AXL_TIMEOUT_S", "10")),
        )

    def _port_for(self, agent: Persona) -> int:
        # Simple shard: even id -> node A, odd id -> node B.
        idx = int(agent.agent_id[1:]) if agent.agent_id[1:].isdigit() else 0
        return self.node_a_port if idx % 2 == 0 else self.node_b_port

    def send(self, from_agent: Persona, to_agent: Persona, payload: str) -> str:
        sender_port = self._port_for(from_agent)
        receiver_port = self._port_for(to_agent)
        destination = to_agent.axl_key
        if not destination:
            raise RuntimeError(f"Missing axl_key for {to_agent.agent_id}")

        with httpx.Client(timeout=self.timeout_s) as client:
            resp = client.post(
                f"http://127.0.0.1:{sender_port}/send",
                headers={"X-Destination-Peer-Id": destination, "Content-Type": "text/plain"},
                content=payload.encode("utf-8"),
            )
            resp.raise_for_status()

            deadline = time.monotonic() + self.timeout_s
            while time.monotonic() < deadline:
                rcv = client.get(f"http://127.0.0.1:{receiver_port}/recv")
                if rcv.status_code == 200:
                    return f"axl:{from_agent.agent_id}->{to_agent.agent_id}"
                if rcv.status_code != 204:
                    rcv.raise_for_status()
                time.sleep(0.2)
        raise RuntimeError(f"AXL receive timeout for {to_agent.agent_id}")

