import { Keypair } from '@stellar/stellar-sdk';
import { AccountManager } from '../src/accounts/manager';
import { TrustFlowError } from '../src/errors';

describe('AccountManager keypair update and accountChanged events - Issue #360', () => {
  let manager: AccountManager;
  let kp1: Keypair;
  let kp2: Keypair;

  beforeEach(() => {
    manager = new AccountManager();
    kp1 = Keypair.random();
    kp2 = Keypair.random();
  });

  it('updates the internal keypair and returns it via getKeypair()', () => {
    expect(manager.getKeypair()).toBeNull();
    manager.setKeypair(kp1);
    expect(manager.getKeypair()).toBe(kp1);
    expect(manager.getKeypair()?.publicKey()).toBe(kp1.publicKey());

    manager.setKeypair(kp2);
    expect(manager.getKeypair()).toBe(kp2);
    expect(manager.getKeypair()?.publicKey()).toBe(kp2.publicKey());
  });

  it('emits accountChanged event with the new public key on setKeypair()', () => {
    const events: string[] = [];
    manager.on('accountChanged', (pk) => {
      events.push(pk);
    });

    manager.setKeypair(kp1);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(kp1.publicKey());

    manager.setKeypair(kp2);
    expect(events).toHaveLength(2);
    expect(events[1]).toBe(kp2.publicKey());
  });

  it('unsubscribes listeners using the returned cleanup function from on()', () => {
    const events: string[] = [];
    const unsubscribe = manager.on('accountChanged', (pk) => {
      events.push(pk);
    });

    manager.setKeypair(kp1);
    expect(events).toEqual([kp1.publicKey()]);

    unsubscribe();

    manager.setKeypair(kp2);
    expect(events).toEqual([kp1.publicKey()]);
  });

  it('unsubscribes listeners using off()', () => {
    const events: string[] = [];
    const listener = (pk: string) => {
      events.push(pk);
    };

    manager.on('accountChanged', listener);
    manager.setKeypair(kp1);
    expect(events).toEqual([kp1.publicKey()]);

    manager.off('accountChanged', listener);
    manager.setKeypair(kp2);
    expect(events).toEqual([kp1.publicKey()]);
  });

  it('supports addListener and removeListener aliases', () => {
    const events: string[] = [];
    const listener = (pk: string) => {
      events.push(pk);
    };

    manager.addListener('accountChanged', listener);
    manager.setKeypair(kp1);
    expect(events).toEqual([kp1.publicKey()]);

    manager.removeListener('accountChanged', listener);
    manager.setKeypair(kp2);
    expect(events).toEqual([kp1.publicKey()]);
  });

  it('removes all listeners with removeAllListeners()', () => {
    const events1: string[] = [];
    const events2: string[] = [];

    manager.on('accountChanged', (pk) => events1.push(pk));
    manager.on('accountChanged', (pk) => events2.push(pk));

    manager.setKeypair(kp1);
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);

    manager.removeAllListeners('accountChanged');

    manager.setKeypair(kp2);
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  it('delivers events to multiple listeners in registration order', () => {
    const order: number[] = [];

    manager.on('accountChanged', () => order.push(1));
    manager.on('accountChanged', () => order.push(2));
    manager.on('accountChanged', () => order.push(3));

    manager.setKeypair(kp1);
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not allow listener errors to prevent subsequent listeners or crash setKeypair', () => {
    const received: string[] = [];

    manager.on('accountChanged', () => {
      throw new Error('Subscriber error');
    });
    manager.on('accountChanged', (pk) => {
      received.push(pk);
    });

    expect(() => manager.setKeypair(kp1)).not.toThrow();
    expect(received).toEqual([kp1.publicKey()]);
  });

  it('notifies subscribers across multiple sequential setKeypair() calls', () => {
    const events: string[] = [];
    const aliceKp = Keypair.random();
    const bobKp = Keypair.random();

    manager.on('accountChanged', (pk) => events.push(pk));

    manager.setKeypair(aliceKp);
    expect(events).toEqual([aliceKp.publicKey()]);

    manager.setKeypair(bobKp);
    expect(events).toEqual([aliceKp.publicKey(), bobKp.publicKey()]);
  });

  it('validates keypair input and throws TrustFlowError with VALIDATION_ERROR on invalid argument', () => {
    expect(() => manager.setKeypair(null as any)).toThrow(TrustFlowError);
    expect(() => manager.setKeypair({} as any)).toThrow(TrustFlowError);

    try {
      manager.setKeypair(null as any);
    } catch (err: any) {
      expect(err).toBeInstanceOf(TrustFlowError);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.field).toBe('keypair');
    }
  });
});
