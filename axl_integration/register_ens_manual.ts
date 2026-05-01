import { createWalletClient, createPublicClient, http, parseEther } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { addEnsContracts } from '@ensdomains/ensjs'
import { commitName, registerName, setTextRecord } from '@ensdomains/ensjs/wallet'
import { getPrice, getAvailable, getTextRecord } from '@ensdomains/ensjs/public'
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

  const available = await getAvailable(publicClient, { name })
  if (available) {
    console.log(`Name ${name} is available. Registering...`)
    
    const secret = "0x" + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join('');

    console.log("Committing with secret:", secret)
    try {
      const commitTx = await commitName(walletClient, {
        name,
        duration: 31536000,
        owner: account.address,
        secret,
      })
      console.log("Commit Tx:", commitTx)
      await publicClient.waitForTransactionReceipt({ hash: commitTx })
    } catch (e) {
      console.log("Commit failed or already committed:", e)
    }
    
    console.log("Waiting 70 seconds for commit to mature...")
    await new Promise(r => setTimeout(r, 70000))
    
    console.log("Registering...")
    const registerTx = await registerName(walletClient, {
      name,
      duration: 31536000,
      owner: account.address,
      secret,
      value: parseEther('0.05'), // Overpay to avoid revert due to price oracle fluctuation
    })
    console.log("Register Tx:", registerTx)
    await publicClient.waitForTransactionReceipt({ hash: registerTx })
    console.log("Registered!", registerTx)
  } else {
    console.log(`Name ${name} is already registered. Assuming we own it and proceeding to set record.`)
  }

  console.log(`Setting AXL Key text record for ${name}...`)
  const textTx = await setTextRecord(walletClient, {
    name,
    key: 'axl_key',
    value: axlKey,
  })
  console.log("Text Tx:", textTx)
  await publicClient.waitForTransactionReceipt({ hash: textTx })
  
  console.log(`Resolving AXL Key text record for ${name}...`)
  const resolved = await getTextRecord(publicClient, { name, key: 'axl_key' })
  console.log(`Resolved axl_key:`, resolved)
}

async function main() {
  const nonce = Math.floor(Math.random() * 10000);
  await registerAndSet(`citysim-agent-${nonce}a.eth`, 'axl_pub_key_node_A_12345')
  await registerAndSet(`citysim-agent-${nonce}b.eth`, 'axl_pub_key_node_B_67890')
}

main().catch(console.error)
