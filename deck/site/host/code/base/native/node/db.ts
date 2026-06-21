export interface Row {
  handle: number
}

export function connect(url: string): number {
  postgres.connect(url)
}

export async function query(sql: string, params: number[]): Promise<number[]> {
  return await postgres.query(sql, params)
}

export async function run(sql: string, params: number[]): Promise<number> {
  await postgres.run(sql, params)
}

export function field(row: Row, name: string): string {
  return postgres.field(row, name)
}
