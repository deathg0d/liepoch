export class LiepochError extends Error {
    constructor(message: string) {
        super(`Liepoch: ${message}`);
        this.name = 'LiepochError';
    }
}

export class Liepoch {
    private wallTime: bigint = 0n;
    private logical: bigint = 0n;

    private static readonly MAX_LOGICAL  = 0xFFFFn;
    private static readonly MAX_DRIFT_MS = 300000n;
    private static readonly PAD_LENGTH   = 16;

    private now(): bigint {
        return BigInt(Date.now());
    }

    /**
     * Serialize a BigInt stamp to a fixed-width, zero-padded lowercase hex string.
     * 16 hex chars = 64 bits. Sorts correctly lexicographically in any DB or index.
     * Safe round-trip via deserialize().
     */
    public static serialize(stamp: bigint): string {
        return stamp.toString(16).padStart(Liepoch.PAD_LENGTH, '0');
    }

    /**
     * Deserialize a stamp string back to BigInt.
     * Accepts bare hex ("0000018f..."), prefixed ("0x0000018f..."),
     * and uppercase hex ("0000018F...").
     */
    public static deserialize(stamp: string): bigint {
        const clean = stamp.replace(/^0x/i, '');
        if (!/^[0-9a-f]+$/i.test(clean)) {
            throw new LiepochError("Invalid hex string provided to deserialize().");
        }
        return BigInt('0x' + clean);
    }

    /**
     * Used primarily for testing to explicitly set the internal clock.
     */
    public _setTestingState(wallTime: bigint, logical: bigint): void {
        this.wallTime = wallTime;
        this.logical = logical;
    }

    public stamp(): bigint {
        const currentWall = this.now();

        let nextWall    = this.wallTime;
        let nextLogical = this.logical;

        if (currentWall > this.wallTime) {
            nextWall    = currentWall;
            nextLogical = 0n;
        } else {
            if (this.wallTime - currentWall > Liepoch.MAX_DRIFT_MS) {
                throw new LiepochError(
                    `Local physical clock is ${this.wallTime - currentWall}ms behind the last ` +
                    `recorded wall time, exceeding MAX_DRIFT_MS (${Liepoch.MAX_DRIFT_MS}ms). ` +
                    `This usually means NTP jumped the clock backward. ` +
                    `Restart the process once the clock stabilizes.`
                );
            }
            nextLogical++;
            if (nextLogical > Liepoch.MAX_LOGICAL) {
                throw new LiepochError(
                    "Logical clock overflow in stamp(). Throughput too high for 16-bit counter."
                );
            }
        }

        this.wallTime = nextWall;
        this.logical  = nextLogical;

        return (this.wallTime << 16n) | this.logical;
    }

    public receive(incoming: bigint | string): bigint {
        if (typeof incoming !== 'bigint' && typeof incoming !== 'string') {
            throw new LiepochError(
                `receive() requires a BigInt or String. Got: ${typeof incoming}. ` +
                `If reading from a JSON payload, the sender must serialize the timestamp ` +
                `as a string before JSON.stringify(). Wrapping an already-parsed number ` +
                `in String() will not recover lost precision.`
            );
        }

        const inc         = typeof incoming === 'string' ? Liepoch.deserialize(incoming) : incoming;
        const currentWall = this.now();
        const msgTime     = inc >> 16n;
        const msgLogical  = inc & 0xFFFFn;

        if (msgTime > currentWall && msgTime - currentWall > Liepoch.MAX_DRIFT_MS) {
            throw new LiepochError(
                `Incoming timestamp is ${msgTime - currentWall}ms in the future, ` +
                `exceeding MAX_DRIFT_MS (${Liepoch.MAX_DRIFT_MS}ms).`
            );
        }

        let maxTime = currentWall;
        if (this.wallTime > maxTime) maxTime = this.wallTime;
        if (msgTime > maxTime)       maxTime = msgTime;

        let nextLogical: bigint;

        if (maxTime === this.wallTime && maxTime === msgTime) {
            nextLogical = (this.logical > msgLogical ? this.logical : msgLogical) + 1n;
        } else if (maxTime === this.wallTime) {
            nextLogical = this.logical + 1n;
        } else if (maxTime === msgTime) {
            nextLogical = msgLogical + 1n;
        } else {
            nextLogical = 0n;
        }

        if (nextLogical > Liepoch.MAX_LOGICAL) {
            throw new LiepochError(
                "Logical clock overflow in receive(). State has not been mutated."
            );
        }

        this.wallTime = maxTime;
        this.logical  = nextLogical;

        return (this.wallTime << 16n) | this.logical;
    }

    /**
     * Unpack a timestamp into human-readable components.
     */
    public static unpack(stamp: bigint | string): { time_ms: number; logical: number; date: Date } {
        const val     = typeof stamp === 'string' ? Liepoch.deserialize(stamp) : stamp;
        const time_ms = Number(val >> 16n);
        return {
            time_ms,
            logical : Number(val & 0xFFFFn),
            date    : new Date(time_ms)
        };
    }
}

// ---------------------------------------------------------
// Default singleton + ergonomic string API
// ---------------------------------------------------------
export const clock = new Liepoch();

export const stamp       = ():                    string  => Liepoch.serialize(clock.stamp());
export const receive     = (ts: string | bigint): string  => Liepoch.serialize(clock.receive(ts));
export const unpack      = Liepoch.unpack;
export const serialize   = Liepoch.serialize;
export const deserialize = Liepoch.deserialize;

export const before = (a: string | bigint, b: string | bigint): boolean => {
    const valA = typeof a === 'bigint' ? a : Liepoch.deserialize(a);
    const valB = typeof b === 'bigint' ? b : Liepoch.deserialize(b);
    return valA < valB;
};