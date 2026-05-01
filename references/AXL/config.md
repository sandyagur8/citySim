# Configuration

## Overview

The node reads a single JSON file (default: `node-config.json`) at startup. Every field is optional, so if you omit a field, its default value is used. You only need to include settings you want to change.

### CLI Flags

You can run `./node [flags]` once your node is up and running.

| Flag      | Description                                          | Default            |
| --------- | ---------------------------------------------------- | ------------------ |
| `-config` | Path to config file                                  | `node-config.json` |
| `-listen` | Listen address for incoming peers (overrides config) | *(none)*           |

The `-listen` flag is for hosting a public node that accepts inbound peer connections, making your node a bootstrap/relay point for others to connect to.&#x20;

This requires exposing a port on the public internet. If you're just connecting outbound to existing peers (the normal case), you don't need this flag.

#### node-config.json

All of these fields are optional. For any fields that are left blank, default values are applied.

#### Network Identity & Peering

The config file is shared between two systems: **\[1]** Yggdrasil (the network layer) and the **\[2]** AXL node (the application layer).&#x20;

This is why the casing differs: `PrivateKeyPath` and `Peers` are Yggdrasil settings (PascalCase), while `api_port` and `tcp_port` are AXL node settings (snake\_case). Both live in the same file.

| Field            | Type      | Description                                                | Example                  |
| ---------------- | --------- | ---------------------------------------------------------- | ------------------------ |
| `PrivateKeyPath` | string    | Path to ed25519 PEM key file. Omit for ephemeral identity. | `"private.pem"`          |
| `Peers`          | string\[] | Bootstrap peer URIs to connect to on startup.              | `["tls://1.2.3.4:9001"]` |
| `Listen`         | string\[] | Addresses to listen for incoming peer connections.         | `["tls://0.0.0.0:9001"]` |

### Node Settings

| Field                    | Type   | Default     | Description                               |
| ------------------------ | ------ | ----------- | ----------------------------------------- |
| `api_port`               | int    | `9002`      | HTTP interface port                       |
| `bridge_addr`            | string | `127.0.0.1` | HTTP interface bind address               |
| `tcp_port`               | int    | `7000`      | Internal TCP listener port (gVisor)       |
| `router_addr`            | string | *(empty)*   | MCP Router host. Empty = MCP disabled.    |
| `router_port`            | int    | `9003`      | MCP Router port                           |
| `a2a_addr`               | string | *(empty)*   | A2A Server host. Empty = A2A disabled.    |
| `a2a_port`               | int    | `9004`      | A2A Server port                           |
| `max_message_size`       | int    | `16777216`  | Max message size in bytes (default 16 MB) |
| `max_concurrent_conns`   | int    | `128`       | Max concurrent inbound TCP connections    |
| `conn_read_timeout_secs` | int    | `60`        | Read timeout per connection (seconds)     |
| `conn_idle_timeout_secs` | int    | `300`       | Idle timeout per connection (seconds)     |

{% hint style="warning" %}
A note on `bridge_addr`: The default `127.0.0.1` means only your local machine can reach the HTTP API. If you change this to `0.0.0.0`, the API is exposed to your entire network. Anyone who can reach that port can send messages as your node.&#x20;

*Do not change this unless you understand the implications.*
{% endhint %}

#### Resource & Connection Limits

These protect the node against resource exhaustion from misbehaving or flooding peers.&#x20;

The defaults are appropriate for most setups. You only need to tune these if you're running a high-traffic public node or operating in a constrained environment.

| Field                    | Type | Default    | Description                                   |
| ------------------------ | ---- | ---------- | --------------------------------------------- |
| `max_message_size`       | int  | `16777216` | Max TCP message size in bytes (default 16 MB) |
| `max_concurrent_conns`   | int  | `128`      | Max simultaneous inbound TCP connections      |
| `conn_read_timeout_secs` | int  | `60`       | Read timeout per connection (seconds)         |
| `conn_idle_timeout_secs` | int  | `300`      | Idle timeout per connection (seconds)         |

#### Enabling MCP & A2A

Setting `router_addr` or `a2a_addr` in the config tells the node to route matching inbound messages to those services.&#x20;

But the config alone doesn't start the services: you also need the Python processes running. Spin up those processes like this:

```bash
# MCP Router (must be running at router_addr:router_port)
cd integrations
pip install -e .
python -m mcp_routing.mcp_router --port 9003

# A2A Server (must be running at a2a_addr:a2a_port)
python -m a2a_serving.a2a_server --port 9004 --router http://127.0.0.1:9003
```

If `router_addr` is empty, MCP messages arriving at your node are silently ignored. Same for `a2a_addr` and A2A messages. See [Building Applications & Examples](/tech/agent-exchange-layer/examples-and-building.md) for full setup walkthroughs.

### Example Configurations

Standard (persistent identity, one bootstrap peer):

```json
{
  "PrivateKeyPath": "private.pem",
  "Peers": ["tls://1.2.3.4:9001"]
}
```

Public node (accepting inbound peers):

```json
{
  "PrivateKeyPath": "private.pem",
  "Peers": [],
  "Listen": ["tls://0.0.0.0:9001"]
}
```

With MCP and A2A enabled:

```json
{
  "PrivateKeyPath": "private.pem",
  "Peers": ["tls://1.2.3.4:9001"],
  "router_addr": "http://127.0.0.1",
  "router_port": 9003,
  "a2a_addr": "http://127.0.0.1",
  "a2a_port": 9004
}
```

Here is what two nodes looks like on the same machine. *Node A* uses defaults, but *Node B* needs different ports:

```json
{
  "PrivateKeyPath": "private-2.pem",
  "Peers": [],
  "api_port": 9012,
  "tcp_port": 7001
}
```

#### LAN "Hub-and-spoke"

**\[1]** Hub (listening):

```json
{
  "PrivateKeyPath": "private.pem",
  "Listen": ["tls://0.0.0.0:9001"]
}
```

**\[2]** Spoke (connecting to hub):

```json
{
  "PrivateKeyPath": "private.pem",
  "Peers": ["tls://192.168.0.22:9001"]
}
```

**\[3]** Custom resource limits (for high-traffic public nodes):

```json
{
  "PrivateKeyPath": "private.pem",
  "Listen": ["tls://0.0.0.0:9001"],
  "max_concurrent_conns": 512,
  "max_message_size": 33554432,
  "conn_read_timeout_secs": 30,
  "conn_idle_timeout_secs": 120
}
```

See [How It Works](/tech/agent-exchange-layer/how-it-works.md) for the full picture of what's happening under the hood.


---

# Agent Instructions: Querying This Documentation

If you need additional information that is not directly available in this page, you can query the documentation dynamically by asking a question.

Perform an HTTP GET request on the current page URL with the `ask` query parameter:

```
GET https://docs.gensyn.ai/tech/agent-exchange-layer/configuration.md?ask=<question>
```

The question should be specific, self-contained, and written in natural language.
The response will contain a direct answer to the question and relevant excerpts and sources from the documentation.

Use this mechanism when the answer is not explicitly present in the current page, you need clarification or additional context, or you want to retrieve related documentation sections.
