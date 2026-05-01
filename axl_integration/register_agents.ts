import { createWalletClient, createPublicClient, http, namehash } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { addEnsContracts } from '@ensdomains/ensjs'
import { commitName, registerName, setTextRecord } from '@ensdomains/ensjs/wallet'
import { getAvailable, getPrice } from '@ensdomains/ensjs/public'
import * as dotenv from 'dotenv'

dotenv.config()

async function registerRealName(label: string, axlKey: string) {
  const account = mnemonicToAccount(process.env.MNEMONIC!)
  console.log("Address:", account.address)

  const publicClient = createPublicClient({
    chain: addEnsContracts(sepolia),
    transport: http(process.env.RPC_URL)
  })

  const walletClient = createWalletClient({
    account,
    chain: addEnsContracts(sepolia),
    transport: http(process.env.RPC_URL)
  })

  const name = `${label}.eth`
  console.log(`Checking availability for ${name}...`)
  const available = await getAvailable(publicClient, { name })
  
  if (available) {
    console.log(`Name is available. Committing...`)
    const secret = "0x" + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join('') as `0x${string}`;
    const price = await getPrice(publicClient, { nameOrNames: name, duration: 31536000 })
    
    // 1. Commit
    const commitParams = {
        name,
        duration: 31536000,
        owner: account.address,
        secret,
    };
    const commitTx = await commitName(walletClient, commitParams)
    console.log("Commit Tx:", commitTx)
    await publicClient.waitForTransactionReceipt({ hash: commitTx })
    
    console.log("Waiting 70 seconds for commit to mature...")
    await new Promise(r => setTimeout(r, 70000))
    
    // 2. Register
    console.log("Registering...")
    const valueToSend = ((price.base + price.premium) * 110n) / 100n; 
    const registerTx = await registerName(walletClient, {
      ...commitParams,
      value: valueToSend,
    })
    console.log("Register Tx:", registerTx)
    await publicClient.waitForTransactionReceipt({ hash: registerTx })
    console.log("Registered successfully!")
  } else {
    console.log(`Name ${name} already registered by someone. Assuming we own it.`)
  }
  
  // 3. Set Resolver in ENSRegistry
  console.log("Setting resolver in ENSRegistry...")
  const registryAddress = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
  const publicResolverAddress = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD'
  const node = namehash(name)

  const { request: resolverReq } = await publicClient.simulateContract({
      address: registryAddress,
      abi: [{
          name: 'setResolver', 
          type: 'function', 
          inputs: [{name: 'node', type: 'bytes32'}, {name: 'resolver', type: 'address'}], 
          outputs: []
      }],
      functionName: 'setResolver',
      args: [node, publicResolverAddress],
      account
  });
  const resHash = await walletClient.writeContract(resolverReq)
  await publicClient.waitForTransactionReceipt({ hash: resHash })
  console.log("Resolver set!")

  // 4. Set Text Record
  console.log("Setting AXL Key text record...")
  const textTx = await setTextRecord(walletClient, {
    name,
    key: 'axl_key',
    value: axlKey,
    resolverAddress: publicResolverAddress
  })
  console.log("Text Tx:", textTx)
  await publicClient.waitForTransactionReceipt({ hash: textTx })
  console.log("Text record set!")

  // 5. Verify
  const text = await publicClient.readContract({
      address: publicResolverAddress,
      abi: [{name: 'text', type: 'function', inputs: [{name: 'node', type: 'bytes32'}, {name: 'key', type: 'string'}], outputs: [{type: 'string'}]}],
      functionName: 'text',
      args: [node, 'axl_key']
  });
  console.log(`Success! Resolved axl_key for ${name}:`, text)
}

async function main() {
  const nodeA_Key = '1fd26e5f5247f758e5204b281247036daf95d768b615dccc57de5859078a15b3';
  const nodeB_Key = '63d1c9d07ab3b30c5aaf2c369ee00ae1b264c63194856401049570c1562798cc';
  
  // Use a random nonce just in case 1 and 2 are taken by someone else and we can't set resolver
  const nonce = Math.floor(Math.random() * 10000);
  const nameA = `citysim-agent-1-${nonce}`;
  const nameB = `citysim-agent-2-${nonce}`;

  console.log(`Registering Node A as ${nameA}.eth...`);
  await registerRealName(nameA, nodeA_Key);
  
  console.log(`\nRegistering Node B as ${nameB}.eth...`);
  await registerRealName(nameB, nodeB_Key);
}

main().catch(console.error)
