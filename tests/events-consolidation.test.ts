import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { parseEvent, parseEvents } from '../src/events';
import type { RawContractEvent } from '../src/events';
import { EscrowMonitor } from '../src/escrow/monitor';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const SENDER = 'GBBJWZH4XKP5AGUAFIDJYTVZIYTREPW3RWOBZ6D7STZXCCQ36XE5DPMI';
const RECIPIENT = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37';

function createXdrEvent(
  type: string,
  topics: xdr.ScVal[],
  value: xdr.ScVal,
): RawContractEvent {
  const topicBase64 = [
    xdr.ScVal.scvSymbol(type).toXDR('base64'),
    ...topics.map((t) => t.toXDR('base64')),
  ];
  return {
    type: 'contract',
    ledger: 42,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    contractId: CONTRACT_ID,
    id: 'ev-1',
    pagingToken: 'pt-1',
    value: value.toXDR('base64'),
    topic: topicBase64,
  };
}

describe('Event Parsing with real Soroban XDR (#138, #282, #284)', () => {
  it('decodes real Soroban XDR for escrow_created accurately', () => {
    const raw = createXdrEvent(
      'escrow_created',
      [
        xdr.ScVal.scvString('esc-100'),
        Address.fromString(SENDER).toScVal(),
        Address.fromString(RECIPIENT).toScVal(),
      ],
      nativeToScVal(50_000_000n, { type: 'i128' }),
    );

    const event = parseEvent(raw);
    expect(event).not.toBeNull();
    expect(event?.type).toBe('escrow_created');

    if (event && event.type === 'escrow_created') {
      expect(event.data.escrowId).toBe('esc-100');
      expect(event.data.sender).toBe(SENDER);
      expect(event.data.recipient).toBe(RECIPIENT);
      expect(event.data.amount).toBe(50_000_000n);
    }
  });

  it('decodes escrow_released events with real address and i128 values', () => {
    const raw = createXdrEvent(
      'escrow_released',
      [
        xdr.ScVal.scvString('esc-100'),
        Address.fromString(RECIPIENT).toScVal(),
      ],
      nativeToScVal(25_000_000n, { type: 'i128' }),
    );

    const event = parseEvent(raw);
    expect(event).not.toBeNull();
    expect(event?.type).toBe('escrow_released');

    if (event && event.type === 'escrow_released') {
      expect(event.data.escrowId).toBe('esc-100');
      expect(event.data.recipient).toBe(RECIPIENT);
      expect(event.data.amount).toBe(25_000_000n);
    }
  });

  it('rejects unknown event types by returning null', () => {
    const raw = createXdrEvent(
      'unknown_event_type',
      [xdr.ScVal.scvString('data')],
      xdr.ScVal.scvVoid(),
    );
    expect(parseEvent(raw)).toBeNull();
  });

  it('rejects events with incomplete topics by returning null', () => {
    const raw = {
      type: 'contract',
      ledger: 42,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      contractId: CONTRACT_ID,
      id: 'ev-bad',
      pagingToken: 'pt',
      value: '1000',
      topic: [xdr.ScVal.scvSymbol('escrow_created').toXDR('base64')], // Missing sender & recipient
    };
    expect(parseEvent(raw)).toBeNull();
  });

  it('parseEvents filters out malformed events without throwing or dropping valid events', () => {
    const validRaw = createXdrEvent(
      'escrow_created',
      [
        xdr.ScVal.scvString('esc-good'),
        Address.fromString(SENDER).toScVal(),
        Address.fromString(RECIPIENT).toScVal(),
      ],
      nativeToScVal(1_000_000n, { type: 'i128' }),
    );

    const malformedRaw = {
      type: 'contract',
      ledger: 42,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      contractId: CONTRACT_ID,
      id: 'ev-malformed',
      pagingToken: 'pt-2',
      value: 'not-a-number',
      topic: [xdr.ScVal.scvSymbol('escrow_created').toXDR('base64'), 'invalid-topic'],
    };

    const skipped: any[] = [];
    const events = parseEvents([validRaw, malformedRaw], CONTRACT_ID, {
      onSkip: (ev) => skipped.push(ev),
    });

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('escrow_created');
    expect(skipped.length).toBe(1);
    expect(skipped[0].id).toBe('ev-malformed');
  });

  it('integrates seamlessly with EscrowMonitor handlers', async () => {
    const monitor = new EscrowMonitor();
    const seen: string[] = [];

    monitor.on('escrow_created', (e) => {
      seen.push(e.data.escrowId);
    });

    const validRaw = createXdrEvent(
      'escrow_created',
      [
        xdr.ScVal.scvString('esc-flow'),
        Address.fromString(SENDER).toScVal(),
        Address.fromString(RECIPIENT).toScVal(),
      ],
      nativeToScVal(1_000_000n, { type: 'i128' }),
    );

    const parsed = parseEvents([validRaw], CONTRACT_ID);
    monitor.deliver(parsed);

    await Promise.resolve();
    expect(seen).toEqual(['esc-flow']);
  });
});
