/** Minimal async-or-sync key/value storage both clients can provide (localStorage on web, AsyncStorage on mobile). */
export type KeyValueStorage = {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem?(key: string): Promise<void> | void;
};
