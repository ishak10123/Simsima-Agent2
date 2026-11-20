export class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function errorResult(error) {
  return {
    code: error instanceof AppError ? error.code : 'execution_failed',
    message: error instanceof AppError ? error.message : 'تعذر إتمام العملية. راجع اتصال Brave وحالة الصفحة.',
    ...(error instanceof AppError && Object.keys(error.details).length ? { details: error.details } : {}),
  };
}
