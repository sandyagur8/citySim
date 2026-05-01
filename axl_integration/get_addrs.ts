import { getChainContractAddress } from '@ensdomains/ensjs/contracts';

console.log("ETHRegistrarController:", getChainContractAddress({ client: { chain: { id: 11155111 } } } as any, 'ethRegistrarController'));
console.log("NameWrapper:", getChainContractAddress({ client: { chain: { id: 11155111 } } } as any, 'nameWrapper'));
console.log("PublicResolver:", getChainContractAddress({ client: { chain: { id: 11155111 } } } as any, 'publicResolver'));
