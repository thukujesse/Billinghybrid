/** Domain error with an HTTP status code, surfaced cleanly by the API. */
export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what: string) =>
  new AppError(404, 'not_found', `${what} not found`);

export const badRequest = (msg: string) =>
  new AppError(400, 'bad_request', msg);

export const conflict = (msg: string) =>
  new AppError(409, 'conflict', msg);

export const paymentRequired = (msg: string) =>
  new AppError(402, 'payment_required', msg);
