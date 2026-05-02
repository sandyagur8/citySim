from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass
from typing import Protocol
import logging

import httpx

from citysim.world.personas import Persona

log = logging.getLogger("citysim.interaction.transport")

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
    node_ports_csv: str = ""
    node_peer_ids_csv: str = ""
    node_count: int = 2
    timeout_s: float = 10.0
    poll_interval_s: float = 0.2
    send_retries: int = 2
    backoff_s: float = 0.4
    node_a_peer_id: str = ""
    node_b_peer_id: str = ""

    @classmethod
    def from_env(cls) -> AxlTransport:
        return cls(
            node_a_port=int(os.environ.get("CITYSIM_AXL_NODE_A_PORT", "9002")),
            node_b_port=int(os.environ.get("CITYSIM_AXL_NODE_B_PORT", "9012")),
            node_ports_csv=os.environ.get("CITYSIM_AXL_NODE_PORTS", "").strip(),
            node_peer_ids_csv=os.environ.get("CITYSIM_AXL_NODE_PEER_IDS", "").strip(),
            node_count=max(1, int(os.environ.get("CITYSIM_AXL_NODE_COUNT", "2"))),
            timeout_s=float(os.environ.get("CITYSIM_AXL_TIMEOUT_S", "10")),
            poll_interval_s=float(os.environ.get("CITYSIM_AXL_POLL_INTERVAL_S", "0.2")),
            send_retries=int(os.environ.get("CITYSIM_AXL_SEND_RETRIES", "2")),
            backoff_s=float(os.environ.get("CITYSIM_AXL_BACKOFF_S", "0.4")),
            node_a_peer_id=os.environ.get("CITYSIM_AXL_NODE_A_PEER_ID", "").strip(),
            node_b_peer_id=os.environ.get("CITYSIM_AXL_NODE_B_PEER_ID", "").strip(),
        )

    def _node_ports(self) -> list[int]:
        if self.node_ports_csv:
            vals: list[int] = []
            for raw in self.node_ports_csv.split(","):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    vals.append(int(raw))
                except ValueError:
                    continue
            if vals:
                return vals[: max(1, self.node_count)]
        return [self.node_a_port, self.node_b_port][: max(1, self.node_count)]

    def _node_peer_ids(self) -> list[str]:
        if self.node_peer_ids_csv:
            vals = [v.strip() for v in self.node_peer_ids_csv.split(",") if v.strip()]
            if vals:
                return vals[: max(1, self.node_count)]
        fallback = [self.node_a_peer_id, self.node_b_peer_id]
        return fallback[: max(1, self.node_count)]

    def _port_for(self, agent: Persona) -> int:
        # Agent shard over active node port list.
        idx = int(agent.agent_id[1:]) if agent.agent_id[1:].isdigit() else 0
        ports = self._node_ports()
        return ports[idx % len(ports)]

    def _is_peer_id(self, value: str | None) -> bool:
        if not value:
            return False
        return bool(re.fullmatch(r"[0-9a-fA-F]{64}", value.strip()))

    def _destination_peer_id(self, to_agent: Persona, receiver_port: int) -> str:
        ports = self._node_ports()
        peers = self._node_peer_ids()
        if receiver_port in ports:
            i = ports.index(receiver_port)
            if i < len(peers) and self._is_peer_id(peers[i]):
                return peers[i]
        # Fallback: use persona axl_key only if it looks like a real peer id.
        if self._is_peer_id(to_agent.axl_key):
            return to_agent.axl_key.strip()
        raise RuntimeError(
            f"Missing valid destination peer id for {to_agent.agent_id}. "
            "Set CITYSIM_AXL_NODE_PEER_IDS (or legacy A/B peer-id vars)."
        )

    def send(self, from_agent: Persona, to_agent: Persona, payload: str) -> str:
        sender_port = self._port_for(from_agent)
        receiver_port = self._port_for(to_agent)
        destination = self._destination_peer_id(to_agent, receiver_port)

        log.debug(
            "axl-send start from=%s to=%s sender_port=%d receiver_port=%d payload_len=%d",
            from_agent.agent_id,
            to_agent.agent_id,
            sender_port,
            receiver_port,
            len(payload),
        )
        attempts = max(1, self.send_retries + 1)
        with httpx.Client(timeout=self.timeout_s) as client:
            for attempt in range(1, attempts + 1):
                try:
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
                            log.debug(
                                "axl-recv ok from=%s to=%s receiver_port=%d attempt=%d/%d",
                                from_agent.agent_id,
                                to_agent.agent_id,
                                receiver_port,
                                attempt,
                                attempts,
                            )
                            return f"axl:{from_agent.agent_id}->{to_agent.agent_id}"
                        if rcv.status_code != 204:
                            log.warning(
                                "axl-recv non-204 status=%d from=%s to=%s attempt=%d/%d",
                                rcv.status_code,
                                from_agent.agent_id,
                                to_agent.agent_id,
                                attempt,
                                attempts,
                            )
                            rcv.raise_for_status()
                        time.sleep(self.poll_interval_s)
                except Exception as e:
                    log.warning(
                        "axl-send attempt failed from=%s to=%s attempt=%d/%d err=%s",
                        from_agent.agent_id,
                        to_agent.agent_id,
                        attempt,
                        attempts,
                        e,
                    )
                if attempt < attempts:
                    time.sleep(self.backoff_s * attempt)
        log.warning(
            "axl-timeout from=%s to=%s receiver_port=%d timeout_s=%.2f",
            from_agent.agent_id,
            to_agent.agent_id,
            receiver_port,
            self.timeout_s,
        )
        raise RuntimeError(f"AXL receive timeout for {to_agent.agent_id}")
