export type OperationErrorCode =
  | 'CANCELLED'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'DEPENDENCY_MISSING'
  | 'EXPORT_FAILED'
  | 'NATIVE_MODULE_FAILED'
  | 'UNKNOWN';

export interface OperationSuccess<T> {
  ok: true;
  value: T;
}

export interface OperationFailure {
  ok: false;
  code: OperationErrorCode;
  message: string;
}

export type OperationResult<T> = OperationSuccess<T> | OperationFailure;

export function operationSuccess<T>(value: T): OperationSuccess<T> {
  return { ok: true, value };
}

export function operationFailure(code: OperationErrorCode, message: string): OperationFailure {
  return { ok: false, code, message };
}
