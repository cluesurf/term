export interface Connection {

}

export function connectionClose(): void {}

export function connectionCommit(): void {}

export function connectionDbName(): number {}

export function connectionEscapes(): number {}

export function connectionLastInsertId(): number {}

export function connectionQuotes(): number {}

export function connectionRequests(): number {}

export function connectionRollback(): void {}

export function connectionStartTransaction(): void {}
