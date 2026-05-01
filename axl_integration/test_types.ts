import { registerName, commitName } from '@ensdomains/ensjs/wallet'
type CommitParams = Parameters<typeof commitName>[1]
type RegisterParams = Parameters<typeof registerName>[1]

const c: CommitParams = {} as any;
const r: RegisterParams = {} as any;
