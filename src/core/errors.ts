/**
 * apaleo reports problems as a flat `{ "messages": [ ... ] }` collection
 * (see `MessageItemCollection` in every spec). We mirror that exactly so
 * clients written against the real API parse our errors unchanged.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly messages: string[];

  constructor(status: number, messages: string | string[]) {
    const list = Array.isArray(messages) ? messages : [messages];
    super(list[0] ?? 'Error');
    this.name = 'ApiError';
    this.status = status;
    this.messages = list;
  }

  toBody(): { messages: string[] } {
    return { messages: this.messages };
  }
}

export const badRequest = (m: string | string[]) => new ApiError(400, m);
export const unauthorized = (m: string | string[] = 'You are unauthorized.') => new ApiError(401, m);
export const forbidden = (m: string | string[] = 'Forbidden.') => new ApiError(403, m);
export const notFound = (m: string | string[] = 'The Request-URI could not be found.') => new ApiError(404, m);
export const conflict = (m: string | string[]) => new ApiError(409, m);
export const preconditionFailed = (m: string | string[]) => new ApiError(412, m);
export const unprocessable = (m: string | string[]) => new ApiError(422, m);

/** Thrown when a caller references an entity that does not exist. */
export function mustExist<T>(value: T | undefined | null, what: string, id: string): T {
  if (value === undefined || value === null) {
    throw notFound(`${what} with id '${id}' was not found.`);
  }
  return value;
}
