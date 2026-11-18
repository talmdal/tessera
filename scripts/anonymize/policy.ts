// How every token of an OFX file is treated. Default deny: a tag with no entry here is dropped and reported,
// never passed through — because real files carry fields nobody anticipated, and one unanticipated field is
// one silent leak. See docs/import-export-design.md, "The anonymiser".

export type Policy =
  /** Emitted unchanged. */
  | { kind: 'structural' }
  /** Allowed values; anything else becomes `fallback` and is reported. */
  | { kind: 'enum', allowed: RegExp | readonly string[], fallback: string }
  /** Replaced by a fixed fictional value. */
  | { kind: 'fixed', value: string }
  /** Replaced by a derived value of the same shape. */
  | { kind: 'synthetic', as: 'id' | 'account' | 'routing' | 'payee' | 'memo' | 'number' }
  /** Transformed by a consistent rule. */
  | { kind: 'shifted', as: 'date' | 'amount' | 'balance' }
  /** Removed, the record left valid. */
  | { kind: 'drop' }

export const TRN_TYPES = [
  'CREDIT', 'DEBIT', 'INT', 'DIV', 'FEE', 'SRVCHG', 'DEP', 'ATM', 'POS', 'XFER', 'CHECK', 'PAYMENT', 'CASH',
  'DIRECTDEP', 'DIRECTDEBIT', 'REPEATPMT', 'HOLD', 'OTHER'
] as const

export const ACCOUNT_TYPES = ['CHECKING', 'SAVINGS', 'MONEYMRKT', 'CREDITLINE', 'CD'] as const

/** Elements whose children are judged one by one. An element not listed is dropped whole, with its subtree. */
export const KNOWN_ELEMENTS = new Set([
  'OFX', 'SIGNONMSGSRSV1', 'SONRS', 'STATUS', 'FI',
  'BANKMSGSRSV1', 'STMTTRNRS', 'STMTRS', 'BANKACCTFROM', 'BANKACCTTO', 'BANKTRANLIST', 'STMTTRN',
  'LEDGERBAL', 'AVAILBAL', 'CREDITCARDMSGSRSV1', 'CCSTMTTRNRS', 'CCSTMTRS', 'CCACCTFROM', 'CCACCTTO',
  'PAYEE', 'CURRENCY', 'ORIGCURRENCY'
])

/** The statement elements, whose balances are recomputed from the rows inside them. */
export const STATEMENT_ELEMENTS = new Set(['STMTRS', 'CCSTMTRS'])

const ISO_CURRENCY = /^[A-Z]{3}$/

export const LEAF_POLICIES: Readonly<Record<string, Policy>> = {
  // Sign-on and status
  CODE: { kind: 'enum', allowed: /^\d{1,5}$/, fallback: '0' },
  SEVERITY: { kind: 'enum', allowed: ['INFO', 'WARN', 'ERROR'], fallback: 'INFO' },
  MESSAGE: { kind: 'drop' },
  DTSERVER: { kind: 'shifted', as: 'date' },
  DTPROFUP: { kind: 'shifted', as: 'date' },
  DTACCTUP: { kind: 'shifted', as: 'date' },
  LANGUAGE: { kind: 'enum', allowed: /^[A-Z]{3}$/, fallback: 'ENG' },
  ORG: { kind: 'fixed', value: 'Example Bank' },
  FID: { kind: 'fixed', value: '9999' },
  'INTU.BID': { kind: 'fixed', value: '9999' },
  'INTU.USERID': { kind: 'drop' },
  USERID: { kind: 'drop' },
  USERPASS: { kind: 'drop' },
  USERKEY: { kind: 'drop' },
  GENUSERKEY: { kind: 'drop' },
  SESSCOOKIE: { kind: 'drop' },
  ACCESSKEY: { kind: 'drop' },
  TRNUID: { kind: 'synthetic', as: 'id' },
  CLTCOOKIE: { kind: 'drop' },

  // The account
  CURDEF: { kind: 'enum', allowed: ISO_CURRENCY, fallback: 'CAD' },
  BANKID: { kind: 'synthetic', as: 'routing' },
  BRANCHID: { kind: 'synthetic', as: 'account' },
  ACCTID: { kind: 'synthetic', as: 'account' },
  ACCTTYPE: { kind: 'enum', allowed: ACCOUNT_TYPES, fallback: 'CHECKING' },
  ACCTKEY: { kind: 'drop' },

  // The rows
  DTSTART: { kind: 'shifted', as: 'date' },
  DTEND: { kind: 'shifted', as: 'date' },
  TRNTYPE: { kind: 'enum', allowed: TRN_TYPES, fallback: 'OTHER' },
  DTPOSTED: { kind: 'shifted', as: 'date' },
  DTUSER: { kind: 'shifted', as: 'date' },
  DTAVAIL: { kind: 'shifted', as: 'date' },
  TRNAMT: { kind: 'shifted', as: 'amount' },
  FITID: { kind: 'synthetic', as: 'id' },
  CORRECTFITID: { kind: 'synthetic', as: 'id' },
  CORRECTACTION: { kind: 'enum', allowed: ['REPLACE', 'DELETE'], fallback: 'REPLACE' },
  SRVRTID: { kind: 'synthetic', as: 'id' },
  CHECKNUM: { kind: 'synthetic', as: 'number' },
  REFNUM: { kind: 'synthetic', as: 'number' },
  NAME: { kind: 'synthetic', as: 'payee' },
  MEMO: { kind: 'synthetic', as: 'memo' },
  PAYEEID: { kind: 'drop' },
  ADDR1: { kind: 'drop' },
  ADDR2: { kind: 'drop' },
  ADDR3: { kind: 'drop' },
  CITY: { kind: 'drop' },
  STATE: { kind: 'drop' },
  POSTALCODE: { kind: 'drop' },
  COUNTRY: { kind: 'drop' },
  PHONE: { kind: 'drop' },
  EMAIL: { kind: 'drop' },
  CURSYM: { kind: 'enum', allowed: ISO_CURRENCY, fallback: 'CAD' },
  CURRATE: { kind: 'enum', allowed: /^\d+(\.\d+)?$/, fallback: '1.0' },

  // Balances are recomputed from the synthetic rows, never copied
  BALAMT: { kind: 'shifted', as: 'balance' },
  DTASOF: { kind: 'shifted', as: 'date' }
}

/** The OFX 1.x header: which keys may pass, and which carry an identifier. */
export const HEADER_POLICIES: Readonly<Record<string, Policy>> = {
  OFXHEADER: { kind: 'structural' },
  DATA: { kind: 'structural' },
  VERSION: { kind: 'structural' },
  SECURITY: { kind: 'structural' },
  ENCODING: { kind: 'structural' },
  CHARSET: { kind: 'structural' },
  COMPRESSION: { kind: 'structural' },
  // `NONE` is the usual value; a real file id is replaced by one of the same shape
  OLDFILEUID: { kind: 'enum', allowed: ['NONE'], fallback: 'NONE' },
  NEWFILEUID: { kind: 'enum', allowed: ['NONE'], fallback: 'NONE' }
}

export const matches = (allowed: RegExp | readonly string[], value: string) =>
  allowed instanceof RegExp ? allowed.test(value) : allowed.includes(value)
