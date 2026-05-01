# Troubleshooting

## Fixing Common Issues

If something isn't working, you're probably hitting one of the issues below. This page covers the most frequent problems with building, running, and connecting AXL nodes, along with their fixes.

### Build Problems

These issues come up when compiling the node binary or generating keys before you ever run anything.

#### `ed25519` key generation fails on macOS

If `openssl genpkey` fails with "algorithm `ed25519` not found," it's because macOS ships with LibreSSL, which doesn't support `ed25519`.&#x20;

Install and use Homebrew's OpenSSL instead:

```bash
brew install openssl
/opt/homebrew/opt/openssl/bin/openssl genpkey -algorithm ed25519 -out private.pem
```

#### `Go 1.26+` build tag errors

The `gvisor.dev/gvisor` dependency has build tag conflicts with `Go 1.26`.&#x20;

Pin the toolchain for the build:

```bash
GOTOOLCHAIN=go1.25.5 go build -o node ./cmd/node/
```

Alternatively, install `Go 1.25.x` alongside your existing version:

```bash
go install golang.org/dl/go1.25.5@latest
go1.25.5 download
go1.25.5 build -o node ./cmd/node/
```

### Running the Node

Once the binary is built, these are the issues you might hit when starting or connecting to your node.

#### Connection refused on port 9002

The node process isn't running, or you're pointing at the wrong port. Confirm the node is alive and responsive:

```bash
curl http://127.0.0.1:9002/topology
```

{% hint style="info" %}
The default port is `9002`. If you changed it in your config file, use your configured port instead.
{% endhint %}

#### "Address already in use"

A previous node instance or another process is still holding the port. Find and kill it:

```bash
lsof -ti :9002 | xargs kill
```

{% hint style="info" %}
This is a common error that you will likely experience if you are testing out your application repeatedly with 2-4 terminals, especially if some are dedicated terminal instances vs. inside of Cursor or another IDE, etc.
{% endhint %}

### Peering and Connectivity

Peering issues show up as missing messages or an empty topology. Most of the time, the fix is a config change or a short wait.

#### "No connected peers found"

You'll see this error if your node hasn't established any peer connections.&#x20;

The most common causes are an empty `Peers` list in your config, unreachable or shut-down bootstrap nodes, or simply that peering hasn't had time to establish yet.&#x20;

Give it a few seconds, then you can check your current connections with `curl http://127.0.0.1:9002/topology` and look at the `peers` array.

#### Messages not arriving between local test nodes

First, verify both nodes are running. Then confirm you're using the correct public key in the `X-Destination-Peer-Id` header.&#x20;

When testing two nodes on the same machine, they need different `tcp_port` values to avoid conflicts. When communicating between separate machines, they should use the same `tcp_port`.

#### Messages not arriving between machines

Both nodes must be able to reach at least one common peer, whether that's a bootstrap node or a direct connection to each other.&#x20;

Double-check that the bootstrap address is correct, the port is open, and firewalls or port forwarding aren't blocking traffic.

### Python Client Issues

These apply when running the example scripts or any Python code that talks to a node's HTTP API.

#### Dependencie Issues

If you encounter this error (`ModuleNotFoundError: No module named 'requests'`) it means that dependcies are either not installed or there was a failure during installation.&#x20;

Run this command to install:&#x20;

```bash
pip3 install -r examples/python-client/requirements.txt
```

#### urllib3 `NotOpenSSLWarning`

This is a harmless warning on macOS caused by a LibreSSL/OpenSSL mismatch in urllib3. Everything works correctly. You can safely ignore it.

### Quick Reference

| Symptom                      | Fix                                         |
| ---------------------------- | ------------------------------------------- |
| *Can't generate ed25519 key* | Use `/opt/homebrew/opt/openssl/bin/openssl` |
| *Build fails (Go 1.26)*      | `GOTOOLCHAIN=go1.25.5 go build ...`         |
| *Connection refused :9002*   | Start the node                              |
| *Port conflict*              | `lsof -ti :PORT \| xargs kill`              |
| *No peers*                   | Check `Peers` in config, wait a few seconds |
| *Python import errors*       | `pip3 install -r requirements.txt`          |


---

# Agent Instructions: Querying This Documentation

If you need additional information that is not directly available in this page, you can query the documentation dynamically by asking a question.

Perform an HTTP GET request on the current page URL with the `ask` query parameter:

```
GET https://docs.gensyn.ai/tech/agent-exchange-layer/troubleshooting.md?ask=<question>
```

The question should be specific, self-contained, and written in natural language.
The response will contain a direct answer to the question and relevant excerpts and sources from the documentation.

Use this mechanism when the answer is not explicitly present in the current page, you need clarification or additional context, or you want to retrieve related documentation sections.
