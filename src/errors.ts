export interface AppErrorOptions {
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>;
  retriable?: boolean;
  cause?: Error;
  type?: 'validation' | 'not-found' | 'routing' | 'pod-request' | 'job-execution' | 'internal';
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly retriable?: boolean;
  readonly type: NonNullable<AppErrorOptions['type']>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.details = options.details;
    this.retriable = options.retriable;
    this.type = options.type ?? 'internal';
  }

  toResponseBody() {
    return {
      error: {
        code: this.code,
        type: this.type,
        message: this.message,
        details: this.details,
        retriable: this.retriable ?? false
      }
    };
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'statusCode' | 'code' | 'type'> = {}) {
    super(message, {
      ...options,
      statusCode: 404,
      code: 'NOT_FOUND',
      type: 'not-found'
    });
  }
}

export class SchedulingError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'statusCode' | 'code' | 'type'> = {}) {
    super(message, {
      ...options,
      statusCode: 422,
      code: 'SCHEDULING_ERROR',
      type: 'routing'
    });
  }
}

export class JobValidationError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'statusCode' | 'code' | 'type'> = {}) {
    super(message, {
      ...options,
      statusCode: 400,
      code: 'JOB_VALIDATION_ERROR',
      type: 'validation'
    });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'statusCode' | 'code' | 'type'> = {}) {
    super(message, {
      ...options,
      statusCode: 409,
      code: 'CONFLICT',
      type: 'validation'
    });
  }
}

export class PodRequestError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'statusCode' | 'code' | 'type'> = {}) {
    super(message, {
      ...options,
      statusCode: 502,
      code: 'POD_REQUEST_ERROR',
      type: 'pod-request'
    });
  }
}

export class JobExecutionError extends AppError {
  constructor(message: string, options: Omit<AppErrorOptions, 'statusCode' | 'code' | 'type'> = {}) {
    super(message, {
      ...options,
      statusCode: 500,
      code: 'JOB_EXECUTION_ERROR',
      type: 'job-execution'
    });
  }
}
