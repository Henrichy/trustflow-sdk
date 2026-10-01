/**
 * Timezone handling utilities for standardized date operations.
 * Ensures consistent UTC/local time handling across the SDK.
 */

export interface TimezoneOptions {
  /** ISO timezone string (e.g., 'America/New_York') */
  timezone?: string;
}

/**
 * Converts a Date to ISO string in UTC timezone.
 * Ensures all SDK operations use consistent UTC representation.
 */
export function toUTC(date: Date): string {
  if (!(date instanceof Date)) {
    throw new TypeError('Expected a Date instance');
  }
  return date.toISOString();
}

/**
 * Converts a timestamp (ms) to ISO string in UTC.
 */
export function timestampToUTC(timestampMs: number): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0) {
    throw new TypeError('Expected a non-negative integer timestamp in milliseconds');
  }
  return new Date(timestampMs).toISOString();
}

/**
 * Converts an ISO string to a Date instance.
 * Validates ISO 8601 format.
 */
export function parseISO(isoString: string): Date {
  if (typeof isoString !== 'string') {
    throw new TypeError('Expected an ISO 8601 date string');
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO 8601 date string: ${isoString}`);
  }
  return date;
}

/**
 * Gets the current timestamp in milliseconds (UTC).
 */
export function getNowUTC(): number {
  return Date.now();
}

/**
 * Adds milliseconds to a date.
 */
export function addMilliseconds(date: Date, ms: number): Date {
  if (!(date instanceof Date)) {
    throw new TypeError('Expected a Date instance');
  }
  if (!Number.isInteger(ms)) {
    throw new TypeError('Expected an integer millisecond value');
  }
  return new Date(date.getTime() + ms);
}

/**
 * Adds seconds to a date.
 */
export function addSeconds(date: Date, seconds: number): Date {
  if (!(date instanceof Date)) {
    throw new TypeError('Expected a Date instance');
  }
  if (!Number.isInteger(seconds)) {
    throw new TypeError('Expected an integer second value');
  }
  return addMilliseconds(date, seconds * 1000);
}

/**
 * Adds minutes to a date.
 */
export function addMinutes(date: Date, minutes: number): Date {
  if (!(date instanceof Date)) {
    throw new TypeError('Expected a Date instance');
  }
  if (!Number.isInteger(minutes)) {
    throw new TypeError('Expected an integer minute value');
  }
  return addSeconds(date, minutes * 60);
}

/**
 * Adds hours to a date.
 */
export function addHours(date: Date, hours: number): Date {
  if (!(date instanceof Date)) {
    throw new TypeError('Expected a Date instance');
  }
  if (!Number.isInteger(hours)) {
    throw new TypeError('Expected an integer hour value');
  }
  return addMinutes(date, hours * 60);
}

/**
 * Adds days to a date.
 */
export function addDays(date: Date, days: number): Date {
  if (!(date instanceof Date)) {
    throw new TypeError('Expected a Date instance');
  }
  if (!Number.isInteger(days)) {
    throw new TypeError('Expected an integer day value');
  }
  return addHours(date, days * 24);
}

/**
 * Calculates the difference between two dates in milliseconds.
 */
export function diffMilliseconds(dateA: Date, dateB: Date): number {
  if (!(dateA instanceof Date) || !(dateB instanceof Date)) {
    throw new TypeError('Expected two Date instances');
  }
  return Math.abs(dateA.getTime() - dateB.getTime());
}

/**
 * Calculates the difference between two dates in seconds.
 */
export function diffSeconds(dateA: Date, dateB: Date): number {
  if (!(dateA instanceof Date) || !(dateB instanceof Date)) {
    throw new TypeError('Expected two Date instances');
  }
  return Math.floor(diffMilliseconds(dateA, dateB) / 1000);
}

/**
 * Checks if a date is in the past.
 */
export function isPast(date: Date): boolean {
  if (!(date instanceof Date)) {
    throw new TypeError('Expected a Date instance');
  }
  return date.getTime() < Date.now();
}

/**
 * Checks if a date is in the future.
 */
export function isFuture(date: Date): boolean {
  if (!(date instanceof Date)) {
    throw new TypeError('Expected a Date instance');
  }
  return date.getTime() > Date.now();
}

/**
 * Checks if a date is expired relative to a reference date.
 * Default reference is current time (UTC).
 */
export function isExpired(expirationDate: Date, referenceDate?: Date): boolean {
  if (!(expirationDate instanceof Date)) {
    throw new TypeError('Expected a Date instance');
  }
  const ref = referenceDate instanceof Date ? referenceDate : new Date();
  return expirationDate.getTime() <= ref.getTime();
}

/**
 * Formats a date for logging (ISO format).
 */
export function formatISO(date: Date): string {
  if (!(date instanceof Date)) {
    throw new TypeError('Expected a Date instance');
  }
  return toUTC(date);
}

import { TrustFlowError } from '../errors';

/**
 * Normalizes a Date, millisecond timestamp, second timestamp, or ISO string to UTC epoch seconds.
 * Uses `Math.floor(date.getTime() / 1000)` to ensure deterministic, timezone-independent epoch seconds.
 *
 * @param input - Date instance, timestamp in ms or seconds, or ISO string
 * @returns UTC Unix timestamp in seconds
 */
export interface FutureExpirationOptions {
  referenceDate?: Date;
  minBufferSeconds?: number;
}

/**
 * Normalizes Date, number (seconds or ms), or ISO 8601 string to integer UTC epoch seconds.
 *
 * Uses `Math.floor(date.getTime() / 1000)` ensuring identical deterministic values regardless of client local timezone.
 *
 * @param input - Date instance, timestamp number, or ISO date string
 * @param field - Field name for error attribution (defaults to 'expiration')
 * @returns Non-negative UTC epoch seconds
 * @throws {TrustFlowError} `INVALID_EXPIRATION` if input is invalid or cannot be parsed
 */
export function normalizeToUtcSeconds(
  input: Date | number | string,
  field = 'expiration',
): number {
  let ms: number;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw TrustFlowError.invalidExpiration('Invalid Date instance', field);
    }
    ms = input.getTime();
  } else if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw TrustFlowError.invalidExpiration(
        'Expected a non-negative finite number',
        field,
      );
    }
    // If input is greater than 1e11, treat as milliseconds, else seconds
    ms = input > 1e11 ? input : input * 1000;
  } else if (typeof input === 'string') {
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) {
      throw TrustFlowError.invalidExpiration(`Invalid date string: "${input}"`, field);
    }
    ms = parsed.getTime();
  } else {
    throw TrustFlowError.invalidExpiration('Expected Date, number, or string', field);
  }

  return Math.floor(ms / 1000);
}

/**
 * Validates that an expiration timestamp is in the future.
 *
 * @param input - UTC epoch seconds number, Date, or string
 * @param field - Field name for error attribution
 * @param options - Reference date or minimum future buffer in seconds
 * @returns The validated UTC epoch seconds
 * @throws {TrustFlowError} `INVALID_EXPIRATION` if expiration is in the past or present
 */
export function validateFutureExpiration(
  input: Date | number | string,
  field = 'expiration',
  options?: FutureExpirationOptions | Date,
): number {
  const seconds = normalizeToUtcSeconds(input, field);
  const opts: FutureExpirationOptions =
    options instanceof Date ? { referenceDate: options } : options ?? {};

  const refMs = opts.referenceDate instanceof Date ? opts.referenceDate.getTime() : Date.now();
  const nowSeconds = Math.floor(refMs / 1000);
  const minBuffer = opts.minBufferSeconds ?? 0;

  if (seconds <= nowSeconds + minBuffer) {
    throw TrustFlowError.invalidExpiration(
      `Expiration timestamp cannot be in the past and must be in the future (got ${seconds}, current ${nowSeconds})`,
      field,
    );
  }
  return seconds;
}

/**
 * Normalizes milestone expiration or an array of milestones with sequential deadline checks.
 */
export function normalizeMilestoneExpiration<
  T extends { deadline?: Date | number | string; expiration?: Date | number | string },
>(
  input: Date | number | string | T[],
  referenceDate?: Date,
): any {
  if (Array.isArray(input)) {
    let lastDeadline = -1;
    return input.map((milestone, idx) => {
      const field = `milestones[${idx}].deadline`;
      const val = milestone.deadline ?? milestone.expiration;
      if (val === undefined) {
        throw TrustFlowError.invalidExpiration(`Milestone at index ${idx} is missing deadline`, field);
      }
      const seconds = validateFutureExpiration(val, field, { referenceDate });
      if (seconds <= lastDeadline) {
        throw TrustFlowError.invalidExpiration(
          `Milestones must be in chronological order: index ${idx} (${seconds}) <= previous (${lastDeadline})`,
          field,
        );
      }
      lastDeadline = seconds;
      return {
        ...milestone,
        deadline: seconds,
      };
    });
  }

  const seconds = normalizeToUtcSeconds(input as Date | number | string);
  return validateFutureExpiration(seconds, 'expiration', { referenceDate });
}
