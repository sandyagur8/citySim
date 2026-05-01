# Agent eXchange Layer (AXL)

## What is AXL?

Agent eXchange Layer (AXL) is a peer-to-peer network node built by Gensyn.&#x20;

It offers an encrypted, decentralized communication layer for applications, allowing AI agents, ML pipelines, distributed computing, and more to exchange data directly between machines *without* a central server.

Fundamentally, it works like this: you run the node on your machine where it handles all peer-to-peer transport, encryption, and routing. The node exposes a local HTTP bridge as an application interface, compatible with whatever you're building.&#x20;

### Features

AXL is designed to stay out of your way. It runs without root access, works behind NATs, and exposes a plain HTTP interface so any language can use it.

* **No TUN required:** Runs entirely in userspace using gVisor's network stack. No root privileges, no system-level network configuration.
* **No port forwarding needed:** Connects outbound to peers and receives data over the same encrypted tunnel, so standard nodes work behind NATs and firewalls without any extra configuration. If you're bootstrapping a new network from scratch, at least one node needs to be publicly reachable with an exposed port.&#x20;

{% hint style="info" %}
Running a public node on an existing network is also helpful since it adds to the overall robustness of the mesh.
{% endhint %}

* **Simple local interface:** Your application talks to `localhost:9002`. Any language that can make HTTP requests can use AXL.
* **End-to-end encrypted:** All traffic between nodes is encrypted at two layers: TLS for the direct peering link, and Yggdrasil's end-to-end encryption for the full path. Intermediate routing nodes cannot read your messages.
* **Application-agnostic:** The node doesn't care what you send. You could send JSON, protobuf, raw bytes, or tensors.
* **Protocol support:** AXL features built-in support for [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) and [A2A](https://github.com/google/A2A) (Agent-to-Agent) for structured request/response communication between agents.

### At a Glance

Getting two machines talking takes four steps and no infrastructure.

1. You build and run the AXL node binary on your machine.
2. The node connects to the Yggdrasil[^1] mesh network and gets a public key (your identity).
3. You share your public key with another person. They share theirs with you.
4. Your applications communicate through their local nodes. The nodes handle everything else.

It doesn't require any servers, cloud accounts, or DNS. It's just two machines (or more) running nodes that communicate directly over the mesh.

```
      Your Machine                                                  Their Machine
┌──────────────────────┐                                       ┌──────────────────────┐
│  [Your App]          │                                       │  [Their App]         │
│       ↕ HTTP         │                                       │       ↕ HTTP         │
│  [AXL node :9002]    │             ◄── mesh ──►              │  [AXL node :9002]    │
└──────────────────────┘                                       └──────────────────────┘
```

### Philosophy

AXL enforces a clean separation between the **\[1]** network layer (the node) and the **\[2]** application layer (your code). The node is a *pipe* insofar as it moves bytes between peers, but it has no opinion about what those bytes mean.&#x20;

This separation means:

* You can build any application on top of AXL without modifying the node or worrying about transport protocols.
* Multiple applications can share the same node.
* The network handles encryption, routing, and peer discovery. Your application handles business logic.

{% hint style="info" %}
AXL is permissionless. Anyone can run a node or spin up their own private network. There are no gatekeepers.
{% endhint %}

### What You Can Build

Because AXL is just a communication layer, what you build on top is up to you.&#x20;

A few [examples](/tech/agent-exchange-layer/examples-and-building.md#built-in-examples) ship with the repo:

* **AI agent collaboration:** Agents on different machines sharing research signals over MCP
* **Distributed ML inference:** Tensor exchange between nodes using `msgpack`
* **GossipSub:** Pub/sub message propagation across the mesh
* **Convergecast:** Tree-based data aggregation using the network's spanning tree

#### Get Started

Ready to get started? Find documentation [here](/tech/agent-exchange-layer/get-started.md) on cloning the repo, building the node, creating an identity key, configuring it, and making sure everything works.

[^1]: we should link out to libraries that we have used


---

# Agent Instructions: Querying This Documentation

If you need additional information that is not directly available in this page, you can query the documentation dynamically by asking a question.

Perform an HTTP GET request on the current page URL with the `ask` query parameter:

```
GET https://docs.gensyn.ai/tech/agent-exchange-layer.md?ask=<question>
```

The question should be specific, self-contained, and written in natural language.
The response will contain a direct answer to the question and relevant excerpts and sources from the documentation.

Use this mechanism when the answer is not explicitly present in the current page, you need clarification or additional context, or you want to retrieve related documentation sections.
