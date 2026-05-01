# Get Started

## Overview

**\[1]** Clone the [repo](https://github.com/gensyn-ai/axl), **\[2]** build the node, **\[3]** run it, and **\[4]** verify everything works.

{% embed url="<https://github.com/gensyn-ai/axl>" fullWidth="false" %}

### Prerequisites

| Tool           | Required     | Install                                                                                     |
| -------------- | ------------ | ------------------------------------------------------------------------------------------- |
| *Go 1.25.x*    | Yes          | `brew install go` (macOS) or [click here](https://go.dev/dl/)                               |
| *Python 3.9+*  | For examples | Usually pre-installed on macOS/Linux, or [download here](https://www.python.org/downloads/) |
| *pip packages* | For examples | `pip install textual requests`                                                              |

{% hint style="warning" %}
**Go 1.26 compatibility:** The `gvisor.dev/gvisor` dependency has build tag conflicts with Go 1.26. The `toolchain go1.25.5` directive in `go.mod` handles this automatically if you have Go 1.25 installed.&#x20;

If you only have Go 1.26+, prefix build commands with `GOTOOLCHAIN=go1.25.5`.
{% endhint %}

### Clone and Build

This command sequence produces a single binary called `node` in the current directory:

```bash
git clone https://github.com/gensyn-ai/axl.git
cd axl
go build -o node ./cmd/node/
```

### Generate a Key

The node needs an `ed25519` private key for its identity.&#x20;

You have two options: **\[1]** persisting your identity or **\[2]** generating a new key automatically on startup.

#### Option A: Persistent identity (recommended)

Generate a key file so your node keeps the same public key across restarts:

```bash
openssl genpkey -algorithm ed25519 -out private.pem
```

***

**For macOS users specifically:** the default `openssl` on macOS is LibreSSL, which does not support `ed25519`. To get around this, use Homebrew's OpenSLL instead:

```bash
brew install openssl
/opt/homebrew/opt/openssl/bin/openssl genpkey -algorithm ed25519 -out private.pem
```

***

#### Option B: Ephemeral identity

Skip key generation entirely. If you omit `PrivateKeyPath` from your config, the node generates a new identity in memory each time it starts. Fine for quick testing but your public key changes every restart.

### Configure

Create a `node-config.json` in the repo root. If someone gave you a peer address to connect to, add it to the `Peers` array:

```json
{
  "PrivateKeyPath": "private.pem",
  "Peers": ["tls://THEIR_IP:9001"]
}
```

If you don't have a peer address yet (just testing locally), leave `Peers` empty:

```json
{
  "PrivateKeyPath": "private.pem",
  "Peers": []
}
```

That's the minimal config. See the [Configuration](/tech/delphi-sdk/configuration.md) section below for all available settings.

### Start the Node

Run this command:

```bash
./node -config node-config.json
```

You'll see output including the following:

```
Your IPv6 address is 200:abcd:...
Your public key is 1ee862344fb283395143ac9775150d2e5936efd6e78ed0db83e3f290d3d539ef
```

If you get this output, it means your node is now running. Leave this terminal open.

### Verify

Then, run this command in a separate terminal:

```bash
curl -s http://127.0.0.1:9002/topology | python3 -c "import sys,json; d=json.load(sys.stdin); print('Public key:', d['our_public_key']); print('IPv6:', d['our_ipv6'])"
```

If you see your public key and IPv6 address, the node is up and the local interface is reachable.

### Connect with Another Person

Your public key is your address on the network.&#x20;

To 'communicate' with someone, you need to exchange keys (like trading phone numbers):

1. **Find your key:** It's printed on node startup, or run the curl command above.
2. **Share it:** Send your 64-character hex key to the other person via Slack, Discord, email, whatever.
3. **Get theirs:** They do the same.

{% hint style="danger" %}
Remember, this is the 64-character public key, *not* a private key in the `.pem` file. Please do not share that key!
{% endhint %}

Now you can send each other messages or call each other's MCP services.

{% hint style="info" %}
There is no way to look up another node's key from the network. The `/topology` endpoint shows keys of nodes in the spanning tree, but it doesn't tell you who owns them. Keys *must* be exchanged directly between people.
{% endhint %}

### Quick Two-Node Test

The fastest way to verify everything works end-to-end is running two nodes locally. To test this out, follow the list of commands below, running them sequentially in the *proper* terminals.&#x20;

First, generate a second key:

```bash
 /opt/homebrew/opt/openssl/bin/openssl genpkey -algorithm ed25519 -out private-2.pem
```

Create a second config (`node-config-2.json`):

```json
 {
   "PrivateKeyPath": "private-2.pem",
   "Peers": [],
   "Listen": [],
   "api_port": 9012,
   "tcp_port": 7001
 }
```

Start the second node in a new terminal:

```bash
 ./node -config node-config-2.json
```

Finally, send a message between the two nodes (in different terminals) and check the output:

```bash
 NODE_A_KEY=$(curl -s http://127.0.0.1:9002/topology | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
 NODE_B_KEY=$(curl -s http://127.0.0.1:9012/topology | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")

 # Send from B → A
 curl -X POST http://127.0.0.1:9012/send \
   -H "X-Destination-Peer-Id: $NODE_A_KEY" \
   -d "hello from node B"

 # Receive on A
 sleep 1
 curl -v http://127.0.0.1:9002/recv
```

The response body should contain `hello from node B`, and the `X-From-Peer-Id` header should match Node B's public key. This is the exact same flow two people on different machines would use, with the only difference being that they wouldn't need different port numbers.

#### Configuration Reference

Check out [this documentation](/tech/agent-exchange-layer/configuration.md) for the full list of API flags, configuration settings, and some example set-ups.&#x20;


---

# Agent Instructions: Querying This Documentation

If you need additional information that is not directly available in this page, you can query the documentation dynamically by asking a question.

Perform an HTTP GET request on the current page URL with the `ask` query parameter:

```
GET https://docs.gensyn.ai/tech/agent-exchange-layer/get-started.md?ask=<question>
```

The question should be specific, self-contained, and written in natural language.
The response will contain a direct answer to the question and relevant excerpts and sources from the documentation.

Use this mechanism when the answer is not explicitly present in the current page, you need clarification or additional context, or you want to retrieve related documentation sections.
