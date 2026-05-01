import { createWalletClient, createPublicClient, http, parseEther } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { addEnsContracts } from '@ensdomains/ensjs'
import { commitName, registerName, setTextRecord } from '@ensdomains/ensjs/wallet'
import { getAvailable, getTextRecord, getPrice } from '@ensdomains/ensjs/public'
import * as dotenv from 'dotenv'

dotenv.config()

async function registerAndSet(name: string, axlKey: string) {
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

  // Hardcode the Sepolia public resolver to avoid viem undefined contract bugs
  const resolverAddress = '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD' as `0x${string}`
  console.log("Using Public Resolver:", resolverAddress)

  const available = await getAvailable(publicClient, { name })
  if (available) {
    console.log(`Name ${name} is available. Registering...`)
    
    const secret = "0x" + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join('');
    const price = await getPrice(publicClient, { nameOrNames: name, duration: 31536000 })
    
    const params = {
        name,
        duration: 31536000,
        owner: account.address,
        secret,
        resolverAddress,
    };

    console.log("Committing with secret:", secret)
    try {
      const commitTx = await commitName(walletClient, params)
      console.log("Commit Tx:", commitTx)
      await publicClient.waitForTransactionReceipt({ hash: commitTx })
    } catch (e) {
      console.log("Commit failed or already committed:", e)
    }
    
    console.log("Waiting 70 seconds for commit to mature...")
    await new Promise(r => setTimeout(r, 70000))
    
    console.log("Registering...")
    const valueToSend = ((price.base + price.premium) * 110n) / 100n; // Overpay 10%
    const registerTx = await registerName(walletClient, {
      ...params,
      value: valueToSend,
    })
    console.log("Register Tx:", registerTx)
    await publicClient.waitForTransactionReceipt({ hash: registerTx })
    console.log("Registered!", registerTx)
  } else {
    console.log(`Name ${name} is already registered. Cannot set record atomically anymore.`)
  }
  
  console.log(`Setting AXL Key text record for ${name}...`)
  const textTx = await setTextRecord(walletClient, {
    name,
    key: 'axl_key',
    value: axlKey,
    resolverAddress,
  })
  console.log("Text Tx:", textTx)
  await publicClient.waitForTransactionReceipt({ hash: textTx })

  console.log(`Resolving AXL Key text record for ${name}...`)
  const resolved = await getTextRecord(publicClient, { name, key: 'axl_key' })
  console.log(`Resolved axl_key:`, resolved)
}

async function main() {
  await registerAndSet(`citysim-agent-230a.eth`, 'axl_pub_key_node_A_12345')
}

main().catch(console.error)
