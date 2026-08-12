export class ServerError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

export function notFound(resource: string): ServerError {
  return new ServerError('not_found', `${resource} not found`, 404);
}

export function conflict(code: string, message: string): ServerError {
  return new ServerError(code, message, 409);
}
