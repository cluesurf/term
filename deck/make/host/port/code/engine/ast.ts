declare const termbig: any

export interface BigInteger {
  dock: any
}

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"

export function toText10(value: BinaryOp): string {
  if (value === "+") {
    return "+"
  } else if (value === "-") {
    return "-"
  } else if (value === "*") {
    return "*"
  } else if (value === "/") {
    return "/"
  } else if (value === "%") {
    return "%"
  } else if (value === "==") {
    return "=="
  } else if (value === "!=") {
    return "!="
  } else if (value === "<") {
    return "<"
  } else if (value === "<=") {
    return "<="
  } else if (value === ">") {
    return ">"
  } else if (value === ">=") {
    return ">="
  } else if (value === "&&") {
    return "&&"
  } else {
    return "||"
  }
}

export function fromText20(value: string, fallback: BinaryOp): BinaryOp {
  if (value === "+") {
    return "+"
  }
  if (value === "-") {
    return "-"
  }
  if (value === "*") {
    return "*"
  }
  if (value === "/") {
    return "/"
  }
  if (value === "%") {
    return "%"
  }
  if (value === "==") {
    return "=="
  }
  if (value === "!=") {
    return "!="
  }
  if (value === "<") {
    return "<"
  }
  if (value === "<=") {
    return "<="
  }
  if (value === ">") {
    return ">"
  }
  if (value === ">=") {
    return ">="
  }
  if (value === "&&") {
    return "&&"
  }
  if (value === "||") {
    return "||"
  }
  return fallback
}

export type UnaryOp =
  | "-"
  | "!"

export function toText11(value: UnaryOp): string {
  if (value === "-") {
    return "-"
  } else {
    return "!"
  }
}

export function fromText21(value: string, fallback: UnaryOp): UnaryOp {
  if (value === "-") {
    return "-"
  }
  if (value === "!") {
    return "!"
  }
  return fallback
}

export type AssignOp =
  | "="
  | "+="
  | "-="
  | "*="
  | "/="

export function toText12(value: AssignOp): string {
  if (value === "=") {
    return "="
  } else if (value === "+=") {
    return "+="
  } else if (value === "-=") {
    return "-="
  } else if (value === "*=") {
    return "*="
  } else {
    return "/="
  }
}

export function fromText22(value: string, fallback: AssignOp): AssignOp {
  if (value === "=") {
    return "="
  }
  if (value === "+=") {
    return "+="
  }
  if (value === "-=") {
    return "-="
  }
  if (value === "*=") {
    return "*="
  }
  if (value === "/=") {
    return "/="
  }
  return fallback
}

export type IntegerLiteral =
  | { form: "small"; value: number }
  | { form: "big"; value: BigInteger }

export type TemplatePart =
  | { form: "chunk"; value: string }
  | { form: "value"; value: Expression }

export interface MapEntry {
  key: string
  value: Expression
}

export type Expression =
  | { form: "integer"; value: IntegerLiteral }
  | { form: "float"; value: number }
  | { form: "boolean"; value: boolean }
  | { form: "string"; value: string }
  | { form: "template"; parts: TemplatePart[] }
  | { form: "unit" }
  | { form: "array"; items: Expression[] }
  | { form: "map"; entries: MapEntry[] }
  | { form: "variable"; name: string }
  | { form: "binary"; op: BinaryOp; left: Expression; right: Expression }
  | { form: "unary"; op: UnaryOp; operand: Expression }
  | { form: "call"; callee: Expression; args: Expression[] }
  | { form: "await"; expr: Expression }
  | { form: "index"; target: Expression; index: Expression }
  | { form: "member"; target: Expression; name: string }
  | { form: "closure"; params: string[]; body: Statement[]; isAsync?: boolean }

export interface Branch {
  cond: Expression
  body: Statement[]
}

export interface CatchClause {
  name: string
  body: Statement[]
}

export interface SwitchCase {
  match: Expression
  body: Statement[]
}

export type Statement =
  | { form: "let"; name: string; init: Expression; mutable: boolean }
  | { form: "assign"; target: Expression; op: AssignOp; value: Expression }
  | { form: "expression"; expr: Expression }
  | { form: "if"; branches: Branch[]; otherwise: Statement[] }
  | { form: "while"; cond: Expression; body: Statement[] }
  | { form: "switch"; subject: Expression; cases: SwitchCase[]; otherwise: Statement[] }
  | { form: "function"; name: string; params: string[]; body: Statement[]; isAsync?: boolean }
  | { form: "return"; value: Expression }
  | { form: "break" }
  | { form: "continue" }
  | { form: "block"; body: Statement[] }
  | { form: "throw"; value: Expression }
  | { form: "try"; body: Statement[]; catches: CatchClause[]; finallyBody: Statement[] }
  | { form: "for"; name: string; iterable: Expression; body: Statement[] }

export type Program = Statement[]
