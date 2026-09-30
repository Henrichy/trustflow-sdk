/**
 * TrustFlow event types (#108).
 *
 * The single source of truth is `src/events.ts` — it owns the parser that
 * decodes Soroban XDR topics into these shapes. This module re-exports them
 * (the package root re-exports this file) and adds the `EscrowMonitor`-facing
 * aliases.
 *
 * The `escrow.created` dot-notation and the `{ escrowId, payload, blockNumber,
 * txHash }` shape that used to live here are gone: they duplicated — and
 * conflicted with — the parser's `escrow_created` / `ParsedEvent` output, so
 * `parseEvent`'s result could not be fed into an `EscrowMonitor` handler
 * without a translation step that never existed.
 */

export type {
  TrustFlowEventType,
  RawContractEvent,
  ParsedEventBase,
  ParsedEvent,
  ParsedTrustFlowEvent,
  ParsedEventForType,
  EscrowCreatedData,
  EscrowReleasedData,
  DisputeRaisedData,
} from '../events';

import type { ParsedEventForType, ParsedTrustFlowEvent, TrustFlowEventType } from '../events';

/**
 * The event object an `EscrowMonitor` handler receives — now an alias of the
 * parser's discriminated union, so `parseEvents(...)` output flows straight
 * into `EscrowMonitor.deliver` / `startPolling`'s `fetchFn` with no adapter
 * (#108). Narrow on `event.type` to get a typed `event.data`.
 */
export type TrustFlowEvent = ParsedTrustFlowEvent;

export type EventHandler = (event: ParsedTrustFlowEvent) => void | Promise<void>;

/**
 * Every event name `EscrowMonitor.on` / `off` accepts: a
 * {@link TrustFlowEventType}, or the `'*'` wildcard that receives the whole
 * union (#287). Exported so callers can type a variable holding an event name
 * instead of casting a bare `string`.
 */
export type MonitorEventName = TrustFlowEventType | '*';

/**
 * Handler for a single event name, with `event` narrowed to the members of
 * {@link ParsedTrustFlowEvent} that can carry that name (#287). A wildcard
 * registration takes the full union, so it uses {@link EventHandler}.
 */
export type EventHandlerFor<T extends TrustFlowEventType> = (
  event: ParsedEventForType<T>,
) => void | Promise<void>;
