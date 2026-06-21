export interface Row {
  handle: number
}

export function connect(url: string): number {}

export async function query(sql: string, params: number[]): Promise<number[]> {}

export async function run(sql: string, params: number[]): Promise<number> {}

export function field(row: Row, name: string): string {}
