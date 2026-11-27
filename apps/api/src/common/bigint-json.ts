/**
 * JSON support for BigInt columns (money in minor units). Values above
 * Number.MAX_SAFE_INTEGER are serialized as strings so nothing is silently rounded.
 */
declare global {
  interface BigInt {
    toJSON(): number | string;
  }
}

BigInt.prototype.toJSON = function toJSON(this: bigint): number | string {
  return this <= BigInt(Number.MAX_SAFE_INTEGER) && this >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(this)
    : this.toString();
};

export {};
