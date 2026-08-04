/**
 * Error carrying an HTTP status. Fastify reads `.statusCode` off a thrown
 * error and renders `{ statusCode, error, message }`, so route and data-layer
 * code can just `throw httpError(400, …)` instead of threading `reply` around.
 */
export interface HttpError extends Error {
  statusCode: number;
}

export function httpError(statusCode: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  return err;
}
