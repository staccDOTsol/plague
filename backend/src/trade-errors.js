export class TradeError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function tradeFailure(error) {
  if (error instanceof TradeError) return { status: error.status,
    body: { error: error.message, code: error.code, ...error.details } };
  const message = String(error?.message || '');
  if (message.includes('existing holders only')) return { status: 403, body: {
    code: 'EXISTING_HOLDER_REQUIRED',
    error: 'This wallet must already hold this mint before it can buy or receive more. Connect a wallet with a positive balance of the selected mint.',
  } };
  if (/insufficient (funds|lamports)/i.test(message)) return { status: 409, body: {
    code: 'INSUFFICIENT_BALANCE',
    error: 'The wallet has insufficient funds for this transaction. Check the input token balance and SOL for network fees and account rent.',
  } };
  if (/NoExtraAccountsForTransferHook|6050/.test(message)) return { status: 409, body: {
    code: 'HOOK_ACCOUNTS_MISSING', error: 'The active hook account list could not be included. Refresh the route; this transaction cannot be signed yet.',
  } };
  return { status: 503, body: { code: 'TRADE_UNAVAILABLE',
    error: 'The live route could not be prepared. Refresh the quote and try again.' } };
}
