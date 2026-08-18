export class AppError extends Error {
  constructor(code, status, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const invalid = (message) => new AppError('invalid_request', 400, message);
export const unauthorized = () => new AppError('unauthorized', 401, 'valid bearer authentication is required');
export const notFound = () => new AppError('not_found', 404, 'resource not found');
export const gone = (message = 'resource is no longer available') => new AppError('gone', 410, message);
export const conflict = (message, details) => new AppError('intent_conflict', 409, message, details);
export const precondition = (message, etag, details = {}) => new AppError(
  'precondition_failed',
  412,
  message,
  { ...details, ...(etag ? { etag } : {}) },
);
export const resyncRequired = () => new AppError(
  'resync_required',
  409,
  'the durable event cursor is outside the retained contiguous window',
);
export const densityLimit = () => new AppError(
  'density_limit_exceeded',
  422,
  'the authorized exact result set exceeds this session limit',
);
export const fanoutLimit = () => new AppError(
  'fanout_limit_exceeded',
  503,
  'the mutation would exceed the bounded active-session fanout',
);

export function asAppError(error) {
  return error instanceof AppError
    ? error
    : new AppError('internal_error', 500, 'internal server error');
}
