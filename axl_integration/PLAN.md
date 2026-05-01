# Integration Plan for AXL and ENS in City Simulator

## Objective
Build the backend and blockchain integration for a 1M-agent synthetic city simulator, utilizing AXL for P2P agent communication and ENS for agent identity.

## Requirements
1.  **AXL Integration:**
    *   Inter-agent or inter-node communication via AXL.
    *   Must cross separate AXL nodes.
    *   Replaces centralized message broker.
2.  **ENS Integration:**
    *   ENS as identity mechanism for agents.
    *   Resolving addresses, storing metadata, or coordinating interaction.
    *   Must be functional (no hard-coded values).
    *   **CRITICAL:** Must use official ENS smart contracts via a testnet (e.g., Sepolia) or a mainnet fork to qualify for the prize.

## Proposed Architecture

1.  **Identity Layer (ENS on Sepolia):**
    *   Each agent (or at least significant agents/businesses) gets an ENS subname (e.g., `agent1.citysim.eth`).
    *   The ENS text records will store the agent's AXL public key.
    *   When Agent A wants to talk to Agent B, it resolves `agentB.citysim.eth` to get the AXL public key using the official ENS public resolver on the Sepolia testnet.

2.  **Communication Layer (AXL):**
    *   Use AXL's MCP (Model Context Protocol) or A2A pattern for structured dialogue.
    *   Each simulated neighborhood or business cluster could run on its own AXL node to prove cross-node communication.
    *   The "Interaction Layer" from the design doc will use AXL to conduct the LLM-driven dialogues instead of running them in a single process memory space.

3.  **Backend Structure:**
    *   **Node Manager:** Spawns and manages multiple AXL nodes locally (e.g., node per city block or node per establishment).
    *   **ENS Resolver Service:** Interfaces with an Ethereum RPC (Alchemy/Infura for Sepolia) using `web3.py` and the `ens` module to resolve agent identities to AXL keys from the official testnet contracts.
    *   **Interaction Engine:** Triggers the buyer/seller LLM dialogues via AXL MCP/A2A calls.

## Next Steps
1.  Configure a Python script to connect to the Sepolia testnet using `web3.py`.
2.  Write the script to read/write ENS text records using the official Sepolia ENS Registry and Public Resolver.
3.  Draft the Python backend to manage AXL nodes and trigger cross-node communication using the ENS-resolved keys.
