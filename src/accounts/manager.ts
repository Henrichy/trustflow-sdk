import { Keypair } from '@stellar/stellar-sdk';
import { TrustFlowError } from '../errors';
import { isValidStellarAddress } from '../utils/validation';
import type {
  AccountChangeEvent,
  AccountChangeListener,
  AccountContext,
  AccountManagerSnapshot,
  AccountPatch,
  AccountSnapshot,
  AddAccountInput,
} from './types';

/** Snapshot schema version emitted by {@link AccountManager.exportState}. */
export const ACCOUNT_SNAPSHOT_VERSION = 1;

/**
 * Holds every account a {@link import('../client').TrustFlowClient} can act as,
 * and tracks which one is active.
 *
 * Switching accounts is a synchronous field write — no new client, no new
 * Horizon or Soroban connection, no re-initialisation of the retry budget or
 * the balance cache — so `client.useAccount('G…')` is cheap enough to call on
 * every render or wallet event.
 *
 * Lookups accept either an {@link AccountContext.id} or the account's
 * `G...` address, because callers think in addresses while the UI usually has
 * an id to hand.
 *
 * @example
 * ```typescript
 * const accounts = new AccountManager();
 * accounts.add({ address: alice, label: 'Alice', roles: ['depositor'] });
 * accounts.add({ address: bob, label: 'Bob', roles: ['beneficiary'] });
 *
 * accounts.activate(bob);            // switch, no reconnect
 * accounts.active?.address;          // bob
 * accounts.get(alice)?.label;        // 'Alice'
 * ```
 */
export class AccountManager {
  private readonly byId = new Map<string, AccountContext>();
  /**
   * Secondary index from address to id, so a context registered under a custom
   * id is still reachable by its `G...` address — callers think in addresses
   * even when the UI keyed them by id.
   */
  private readonly idByAddress = new Map<string, string>();
  private readonly listeners = new Set<AccountChangeListener>();
  private readonly eventListeners = new Map<string, Set<(...args: any[]) => void>>();
  private currentActiveId: string | null = null;
  private keypair: Keypair | null = null;


  /**
   * Returns the currently configured Keypair, or null if none is set.
   */
  getKeypair(): Keypair | null {
    return this.keypair;
  }

  /**
   * Updates the internal keypair reference, sets it as active, and notifies
   * registered 'accountChanged' listeners with the new public key.
   *
   * @param keypair - Stellar Keypair instance
   */
  setKeypair(keypair: Keypair): void {
    if (!keypair || typeof keypair.publicKey !== 'function') {
      throw TrustFlowError.validation('keypair', 'Expected a valid Keypair instance');
    }
    this.keypair = keypair;
    const newPublicKey = keypair.publicKey();

    this.add({
      address: newPublicKey,
      id: newPublicKey,
      label: 'Active Keypair',
      activate: true,
    });

    this.emit('accountChanged', newPublicKey);
  }

  /**
   * Subscribes a listener to account manager events (e.g. 'accountChanged').
   * Returns an unsubscribe function.
   *
   * @param event - Event name
   * @param listener - Callback function
   * @returns Unsubscribe cleanup function
   */
  on(event: 'accountChanged', listener: (newPublicKey: string) => void): () => void;
  on(event: string, listener: (...args: any[]) => void): () => void;
  on(event: string, listener: (...args: any[]) => void): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);

    return () => {
      this.off(event, listener);
    };
  }

  /**
   * Unsubscribes a listener from account manager events.
   */
  off(event: string, listener: (...args: any[]) => void): void {
    const set = this.eventListeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.eventListeners.delete(event);
      }
    }
  }

  /**
   * EventEmitter-compatible addListener alias for on().
   */
  addListener(event: string, listener: (...args: any[]) => void): this {
    this.on(event, listener);
    return this;
  }

  /**
   * EventEmitter-compatible removeListener alias for off().
   */
  removeListener(event: string, listener: (...args: any[]) => void): this {
    this.off(event, listener);
    return this;
  }

  /**
   * Removes all registered event listeners.
   */
  removeAllListeners(event?: string): this {
    if (event) {
      this.eventListeners.delete(event);
    } else {
      this.eventListeners.clear();
      this.listeners.clear();
    }
    return this;
  }

  /** Number of registered accounts. */
  get size(): number {
    return this.byId.size;
  }

  /** Whether no accounts are registered. */
  get isEmpty(): boolean {
    return this.byId.size === 0;
  }

  /** Id of the active account, or `null` when none is active. */
  get activeId(): string | null {
    return this.currentActiveId;
  }

  /** The active account, or `null` when none is registered. */
  get active(): AccountContext | null {
    return this.currentActiveId === null ? null : (this.byId.get(this.currentActiveId) ?? null);
  }

  /**
   * Registers an account.
   *
   * Re-registering an existing `id` merges the supplied fields into the stored
   * context instead of failing, so restoring persisted state on page load can
   * call `add()` unconditionally.
   *
   * @param input - Address plus optional id, label, API key, roles and data
   * @returns The stored context (frozen, so callers cannot mutate it in place)
   * @throws {TrustFlowError} `VALIDATION_ERROR` for a blank/invalid address
   */
  add(input: AddAccountInput): AccountContext {
    const address = (input.address ?? '').trim();
    if (!address) {
      throw TrustFlowError.validation('address', 'Required');
    }
    if (!isValidStellarAddress(address)) {
      throw TrustFlowError.validation('address', `Not a valid Stellar public key: ${address}`);
    }

    const id = input.id?.trim() || address;
    const existing = this.byId.get(id);
    const now = Date.now();

    if (existing) {
      const merged = this.freeze({
        ...existing,
        address,
        label: input.label ?? existing.label,
        apiKey: input.apiKey ?? existing.apiKey,
        roles: input.roles ? [...input.roles] : existing.roles,
        data: input.data ? { ...existing.data, ...input.data } : existing.data,
        createdAt: existing.createdAt,
        lastUsedAt: existing.lastUsedAt,
      });
      this.index(merged);
      this.emit({ type: 'updated', account: merged, previous: existing });
      this.activateIfRequested(id, input.activate);
      return merged;
    }

    const account = this.freeze({
      id,
      address,
      label: input.label,
      apiKey: input.apiKey,
      roles: input.roles ? [...input.roles] : [...[]],
      data: input.data ? { ...input.data } : {},
      createdAt: now,
      lastUsedAt: undefined,
    });
    this.index(account);
    this.emit({ type: 'added', account });
    this.activateIfRequested(id, input.activate);
    return account;
  }

  /**
   * Merges a patch into a registered account.
   *
   * @param ref - Account id or `G...` address
   * @param patch - Fields to replace (`data` is merged, not replaced)
   * @returns The updated context
   * @throws {TrustFlowError} `ACCOUNT_NOT_FOUND` when `ref` is unknown
   */
  update(ref: string, patch: AccountPatch): AccountContext {
    const current = this.require(ref);
    const next = this.freeze({
      ...current,
      label: patch.label !== undefined ? patch.label : current.label,
      apiKey: patch.apiKey !== undefined ? patch.apiKey : current.apiKey,
      roles: patch.roles ? [...patch.roles] : current.roles,
      data: patch.data ? { ...current.data, ...patch.data } : current.data,
    });
    this.index(next);
    this.emit({ type: 'updated', account: next, previous: current });
    return next;
  }

  /**
   * Unregisters an account. The active account falls back to the first
   * remaining one, or to `null` when none remain.
   *
   * @param ref - Account id or `G...` address
   * @returns `true` when an account was removed
   */
  remove(ref: string): boolean {
    const account = this.get(ref);
    if (!account) return false;
    this.unindex(account.id);
    this.emit({ type: 'removed', account });
    if (this.currentActiveId === account.id) {
      const nextActive = this.byId.keys().next();
      this.currentActiveId = nextActive.done ? null : nextActive.value;
    }
    return true;
  }

  /** Whether `ref` (an id or address) is registered. */
  has(ref: string): boolean {
    return this.resolve(ref) !== null;
  }

  /**
   * Clears the active selection without unregistering anything, returning the
   * client to its pre-multi-account "no account context" state. Used to undo a
   * temporary {@link import('../client').TrustFlowClient.asAccount} switch that
   * started from an empty account list.
   *
   * @returns The account that was active, or `null` when none was
   */
  deactivate(): AccountContext | null {
    const previous = this.active;
    if (previous) {
      this.currentActiveId = null;
    }
    return previous;
  }

  /**
   * Looks up an account without throwing.
   *
   * @param ref - Account id or `G...` address. Omit to get the active account.
   * @returns The context, or `null` when `ref` is unknown or (with no `ref`)
   *   nothing is active.
   */
  get(ref?: string): AccountContext | null {
    if (ref === undefined) return this.active;
    return this.resolve(ref);
  }

  /**
   * Like {@link AccountManager.get}, but throws instead of returning `null`.
   *
   * @throws {TrustFlowError} `ACCOUNT_NOT_FOUND` when `ref` is unknown or
   *   nothing is active
   */
  require(ref?: string): AccountContext {
    const account = this.get(ref);
    if (!account) {
      throw TrustFlowError.accountNotFound(ref);
    }
    return account;
  }

  /** Every registered account, in registration order. */
  list(): AccountContext[] {
    return [...this.byId.values()];
  }

  /**
   * Makes an account active. This is the whole of "account switching": one
   * field write, no client re-initialisation, no new network connection.
   *
   * @param ref - Account id or `G...` address
   * @returns The now-active context
   * @throws {TrustFlowError} `ACCOUNT_NOT_FOUND` when `ref` is unknown
   */
  activate(ref: string): AccountContext {
    const account = this.require(ref);
    if (this.currentActiveId !== account.id) {
      const previousId = this.currentActiveId;
      this.currentActiveId = account.id;
      this.emit({ type: 'activated', account, previousId });
    }
    return account;
  }

  /**
   * Records that an account was just used, stamping `lastUsedAt`. Called by
   * the client on every account-scoped call.
   *
   * @param ref - Account id or `G...` address. Omit for the active account.
   * @returns The stamped context
   */
  touch(ref?: string): AccountContext {
    const account = this.require(ref);
    const stamped = this.freeze({ ...account, lastUsedAt: Date.now() });
    this.index(stamped);
    return stamped;
  }

  /**
   * Reads a single per-account state value.
   *
   * @param ref - Account id or `G...` address. Omit for the active account.
   * @param key - Key in the account's `data` bag
   */
  getData<T = unknown>(ref: string | undefined, key: string): T | undefined {
    return this.get(ref)?.data[key] as T | undefined;
  }
  /**
   * Writes a single per-account state value. `undefined` deletes the key.
   *
   * Unlike {@link AccountManager.update}, `data` is *replaced* rather than
   * merged here, so a deleted key actually disappears instead of surviving as
   * the previous value.
   *
   * @param ref - Account id or `G...` address. Omit for the active account.
   * @param key - Key in the account's `data` bag
   * @param value - Value to store, or `undefined` to remove
   */
  setData(ref: string | undefined, key: string, value: unknown): AccountContext {
    const current = this.require(ref);
    const data = { ...current.data };
    if (value === undefined) {
      delete data[key];
    } else {
      data[key] = value;
    }
    const next = this.freeze({ ...current, data });
    this.index(next);
    this.emit({ type: 'updated', account: next, previous: current });
    return next;
  }

  /**
   * Subscribes to registration, update, removal and activation events.
   *
   * @param listener - Called synchronously after each change
   * @returns An unsubscribe function
   */
  onChange(listener: AccountChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Serialises every account, for persistence across reloads. */
  exportState(): AccountManagerSnapshot {
    return {
      version: ACCOUNT_SNAPSHOT_VERSION,
      accounts: this.list().map((account) => ({
        ...account,
        roles: [...account.roles],
        data: { ...account.data },
      })),
      activeId: this.currentActiveId,
    };
  }

  /**
   * Replaces all accounts with a previously exported snapshot, then activates
   * `activeId` when it survived the import.
   *
   * @throws {TrustFlowError} `VALIDATION_ERROR` for a malformed or
   *   unrecognised-version snapshot
   */
  importState(snapshot: AccountManagerSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.accounts)) {
      throw TrustFlowError.validation('snapshot', 'must have an accounts array');
    }
    if (snapshot.version !== ACCOUNT_SNAPSHOT_VERSION) {
      throw TrustFlowError.validation(
        'snapshot.version',
        `unsupported version ${String(snapshot.version)}; expected ${ACCOUNT_SNAPSHOT_VERSION}`,
      );
    }

    this.clear();

    for (const raw of snapshot.accounts) {
      const account = raw as AccountSnapshot;
      this.add({
        id: account.id,
        address: account.address,
        label: account.label,
        apiKey: account.apiKey,
        roles: account.roles,
        data: account.data,
        activate: false,
      });
    }

    const wanted = snapshot.activeId;
    this.currentActiveId = wanted !== null && this.byId.has(wanted) ? wanted : null;
    if (this.currentActiveId) {
      this.emit({ type: 'activated', account: this.active!, previousId: null });
    }
  }

  /** Unregisters every account and clears the active selection. */
  clear(): void {
    for (const account of this.list()) {
      this.unindex(account.id);
      this.emit({ type: 'removed', account });
    }
    this.currentActiveId = null;
  }

  private activateIfRequested(id: string, requested: boolean | undefined): void {
    if (requested ?? this.byId.size === 1) {
      this.activate(id);
    }
  }

  private resolve(ref: string): AccountContext | null {
    const trimmed = ref.trim();
    const direct = this.byId.get(trimmed);
    if (direct) return direct;
    const id = this.idByAddress.get(trimmed);
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  private index(account: AccountContext): void {
    this.byId.set(account.id, account);
    this.idByAddress.set(account.address, account.id);
  }

  private unindex(id: string): void {
    const account = this.byId.get(id);
    this.byId.delete(id);
    if (account && this.idByAddress.get(account.address) === id) {
      this.idByAddress.delete(account.address);
    }
  }

  private freeze(account: AccountContext): AccountContext {
    return Object.freeze({
      ...account,
      roles: Object.freeze([...account.roles]) as AccountContext['roles'],
    });
  }

  emit(event: string, ...args: any[]): void;
  emit(event: AccountChangeEvent): void;
  emit(eventOrName: string | AccountChangeEvent, ...args: any[]): void {
    if (typeof eventOrName === 'string') {
      const listeners = this.eventListeners.get(eventOrName);
      if (listeners) {
        for (const listener of [...listeners]) {
          try {
            listener(...args);
          } catch {
            // A failing listener must not roll back execution
          }
        }
      }
    } else {
      for (const listener of this.listeners) {
        try {
          listener(eventOrName);
        } catch {
          // A failing listener must not roll back an account change.
        }
      }
    }
  }
}
