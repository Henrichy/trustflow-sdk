import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import { logger } from './utils/logger';

export type TrustFlowEventType =
  | 'escrow_created'
  | 'escrow_funded'
  | 'escrow_released'
  | 'escrow_cancelled'
  | 'dispute_raised'
  | 'dispute_resolved';

const KNOWN_EVENT_TYPES: Set<string> = new Set([
  'escrow_created',
  'escrow_funded',
  'escrow_released',
  'escrow_cancelled',
  'dispute_raised',
  'dispute_resolved',
]);

export interface RawContractEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  topic: string[];
  value: string;
}

export interface ParsedEventBase {
  contractId: string;
  ledger: number;
  timestamp: string;
  id: string;
  pagingToken: string;
}

export interface EscrowCreatedData {
  escrowId: string;
  sender: string;
  recipient: string;
  amount: bigint;
}

export interface EscrowReleasedData {
  escrowId: string;
  recipient: string;
  amount: bigint;
}

export interface DisputeRaisedData {
  escrowId: string;
  raisedBy: string;
  reason: string;
}

export interface ParsedEvent<TType extends string = string, TData = Record<string, unknown>>
  extends ParsedEventBase {
  type: TType;
  data: TData;
}

export type ParsedTrustFlowEvent =
  | ParsedEvent<'escrow_created', EscrowCreatedData>
  | ParsedEvent<'escrow_released', EscrowReleasedData>
  | ParsedEvent<'dispute_raised', DisputeRaisedData>
  | ParsedEvent<TrustFlowEventType, Record<string, unknown>>;

export type ParsedEventForType<T extends TrustFlowEventType> =
  Extract<ParsedTrustFlowEvent, { type: T }> extends never
    ? ParsedEvent<T, Record<string, unknown>>
    : Extract<ParsedTrustFlowEvent, { type: T }>;

/**
 * Decodes a base64 Soroban ScVal into a native JavaScript value using @stellar/stellar-sdk.
 * Fully browser-safe and handles symbols, strings, addresses, integers, and i128 values.
 */
export function decodeScVal(val: unknown): unknown {
  if (val === null || val === undefined || val === '') return '';
  if (typeof val !== 'string') return val;

  try {
    const scVal = xdr.ScVal.fromXDR(val, 'base64');
    // For address types, extract canonical G... or C... address
    if (scVal.switch() === xdr.ScValType.scvAddress()) {
      return Address.fromScVal(scVal).toString();
    }
    const native = scValToNative(scVal);
    return native;
  } catch {
    // If not valid XDR base64, check for lightweight test mock encoding (buf[0] === 0x0e)
    try {
      const buf = typeof Buffer !== 'undefined' ? Buffer.from(val, 'base64') : null;
      if (buf && buf.length >= 5 && buf[0] === 0x0e) {
        return buf.subarray(5).toString('utf8');
      }
    } catch {
      // ignore
    }
    // Return original string (for backwards compatibility)
    return val;
  }
}

function toBigIntSafe(val: unknown): bigint | null {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number' && !isNaN(val)) return BigInt(Math.trunc(val));
  if (typeof val === 'string' && val.trim() !== '') {
    try {
      return BigInt(val.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Check if a raw event belongs to the TrustFlow contract */
export function isTrustFlowEvent(
  event: RawContractEvent,
  contractId: string,
): boolean {
  return event.contractId === contractId && event.type === 'contract';
}

/**
 * Parse a raw Soroban contract event into a typed TrustFlow event.
 * Returns null if the event is malformed, missing required fields, or has an unknown event type.
 */
export function parseEvent(event: RawContractEvent): ParsedTrustFlowEvent | null {
  if (!event || !event.topic || event.topic.length === 0) {
    return null;
  }

  try {
    const rawType = decodeScVal(event.topic[0]);
    const eventType = typeof rawType === 'string' ? rawType : String(rawType);

    if (!KNOWN_EVENT_TYPES.has(eventType)) {
      return null;
    }

    const base: ParsedEventBase = {
      contractId: event.contractId,
      ledger: event.ledger,
      timestamp: event.ledgerClosedAt,
      id: event.id,
      pagingToken: event.pagingToken,
    };

    switch (eventType) {
      case 'escrow_created': {
        if (event.topic.length < 4) return null;
        const escrowId = String(decodeScVal(event.topic[1]) ?? '');
        const sender = String(decodeScVal(event.topic[2]) ?? '');
        const recipient = String(decodeScVal(event.topic[3]) ?? '');
        const decodedValue = decodeScVal(event.value);
        const amount = toBigIntSafe(decodedValue);

        if (!escrowId || !sender || !recipient || amount === null) {
          return null;
        }

        return {
          ...base,
          type: 'escrow_created',
          data: {
            escrowId,
            sender,
            recipient,
            amount,
          },
        };
      }

      case 'escrow_released': {
        if (event.topic.length < 3) return null;
        const escrowId = String(decodeScVal(event.topic[1]) ?? '');
        const recipient = String(decodeScVal(event.topic[2]) ?? '');
        const decodedValue = decodeScVal(event.value);
        const amount = toBigIntSafe(decodedValue);

        if (!escrowId || !recipient || amount === null) {
          return null;
        }

        return {
          ...base,
          type: 'escrow_released',
          data: {
            escrowId,
            recipient,
            amount,
          },
        };
      }

      case 'dispute_raised': {
        if (event.topic.length < 3) return null;
        const escrowId = String(decodeScVal(event.topic[1]) ?? '');
        const raisedBy = String(decodeScVal(event.topic[2]) ?? '');
        const reason = String(decodeScVal(event.value) ?? '');

        if (!escrowId || !raisedBy) {
          return null;
        }

        return {
          ...base,
          type: 'dispute_raised',
          data: {
            escrowId,
            raisedBy,
            reason,
          },
        };
      }

      default:
        return { ...base, type: eventType as TrustFlowEventType, data: {} };
    }
  } catch (err) {
    logger.debug('Failed to parse contract event', { err, eventId: event.id });
    return null;
  }
}

export interface ParseEventsOptions {
  /** Optional callback invoked when a raw event is skipped due to malformed payload or mismatch. */
  onSkip?: (event: RawContractEvent, error?: unknown) => void;
}

/**
 * Parse an array of raw events, filtering nulls and non-TrustFlow events.
 * Malformed events in a batch are skipped cleanly without crashing or discarding valid events.
 */
export function parseEvents(
  events: RawContractEvent[],
  contractId: string,
  options?: ParseEventsOptions,
): ParsedTrustFlowEvent[] {
  const result: ParsedTrustFlowEvent[] = [];

  for (const raw of events) {
    try {
      if (!isTrustFlowEvent(raw, contractId)) {
        continue;
      }
      const parsed = parseEvent(raw);
      if (parsed) {
        result.push(parsed);
      } else {
        if (options?.onSkip) {
          options.onSkip(raw, new Error('Event validation failed or unknown type'));
        }
      }
    } catch (err) {
      logger.warn('Skipping malformed contract event', { eventId: raw.id, err });
      if (options?.onSkip) {
        options.onSkip(raw, err);
      }
    }
  }

  return result;
}

// ── Resilient subscription primitives ────────────────────────────────────────

export interface CursorStore {
  get(): Promise<string | undefined> | string | undefined;
  set(cursor: string): Promise<void> | void;
}

export class InMemoryCursorStore implements CursorStore {
  private cursor?: string;
  constructor(initialCursor?: string) {
    this.cursor = initialCursor;
  }
  get(): string | undefined {
    return this.cursor;
  }
  set(cursor: string): void {
    this.cursor = cursor;
  }
}

export interface FetchContractEventsOptions {
  contractId: string;
  startLedger?: number;
  cursor?: string;
  limit?: number;
}

export interface ContractEventsPage {
  events: RawContractEvent[];
  nextCursor?: string;
  latestLedger?: number;
}

export interface GetEventsRpc {
  getEvents(
    request: Record<string, unknown>,
  ): Promise<{
    events?: Array<Record<string, unknown>>;
    latestLedger?: number;
    cursor?: string;
  }>;
}

export async function fetchContractEvents(
  server: GetEventsRpc,
  options: FetchContractEventsOptions,
): Promise<ContractEventsPage> {
  const { contractId, startLedger, cursor, limit = 100 } = options;
  const request: Record<string, unknown> = {
    filters: [{ type: 'contract', contractIds: [contractId] }],
    limit,
    ...(cursor ? { cursor } : startLedger !== undefined ? { startLedger } : {}),
  };
  const response = await server.getEvents(request);
  const rawEvents = (response.events ?? []) as unknown as RawContractEvent[];
  const nextCursor =
    response.cursor ?? (rawEvents.length > 0 ? rawEvents[rawEvents.length - 1].pagingToken : cursor);
  return { events: rawEvents, nextCursor, latestLedger: response.latestLedger };
}

export function createRpcEventFetcher(
  server: GetEventsRpc,
  options: Omit<FetchContractEventsOptions, 'cursor'>,
): (cursor?: string) => Promise<RawContractEvent[]> {
  return async (cursor?: string) => {
    const page = await fetchContractEvents(server, { ...options, cursor });
    return page.events;
  };
}
