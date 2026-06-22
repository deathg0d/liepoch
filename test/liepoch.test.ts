import test from 'node:test';
import assert from 'node:assert/strict';
import { Liepoch, serialize, deserialize, before, unpack } from '../src/index';

test('Exhaustive Liepoch Tests', async (t) => {
    
    await t.test('SERIALIZATION', async (t) => {
        await t.test('serialize() output is always exactly 16 characters', () => {
            assert.equal(serialize(0n).length, 16);
            assert.equal(serialize(0xFFFFFFFFFFFFFFFFn).length, 16);
        });

        await t.test('serialize() output contains only lowercase hex characters', () => {
            const hex = serialize(0xABCDEF123456n);
            assert.match(hex, /^[0-9a-f]{16}$/);
        });

        await t.test('serialize(deserialize(x)) === x round-trip for edge values', () => {
            const edges = [0n, 1n, 0xFFFFFFFFFFFFFFFFn];
            for (const edge of edges) {
                const roundTripped = deserialize(serialize(edge));
                assert.equal(roundTripped, edge);
            }
        });

        await t.test('deserialize() handles 0x prefix (lowercase and uppercase: 0x, 0X)', () => {
            const expected = 0x1234n;
            assert.equal(deserialize('0x0000000000001234'), expected);
            assert.equal(deserialize('0X0000000000001234'), expected);
        });

        await t.test('deserialize() handles uppercase hex digits (A-F)', () => {
            assert.equal(deserialize('000000000000ABCD'), 0xABCDn);
        });

        await t.test('deserialize() handles mixed case hex', () => {
            assert.equal(deserialize('0x000000000000AbCd'), 0xABCDn);
        });

        await t.test('deserialize() throws LiepochError on empty string', () => {
            assert.throws(() => deserialize(''), { name: 'LiepochError' });
        });

        await t.test('deserialize() throws LiepochError on strings with non-hex chars', () => {
            assert.throws(() => deserialize('000000000000000g'), { name: 'LiepochError' });
            assert.throws(() => deserialize('0x00000000-00000'), { name: 'LiepochError' });
        });

        await t.test('deserialize() throws LiepochError on whitespace-only strings', () => {
            assert.throws(() => deserialize('   '), { name: 'LiepochError' });
        });
    });

    await t.test('STAMP', async (t) => {
        await t.test('First stamp on a fresh clock has logical === 0', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                const unpacked = unpack(clock.stamp());
                assert.equal(unpacked.logical, 0);
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('Physical time advancing resets logical counter to 0', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                clock.stamp();
                clock.stamp(); // logical is now 1
                mockTimeMs = 1001; // Advance time
                const unpacked = unpack(clock.stamp());
                assert.equal(unpacked.logical, 0);
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('stamp() is strictly monotonic: 1000 consecutive stamps in same ms must each be strictly greater', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                let previous = clock.stamp();
                for (let i = 0; i < 1000; i++) {
                    const current = clock.stamp();
                    assert.ok(current > previous, 'Each stamp must be strictly greater than the last');
                    previous = current;
                }
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('stamp() state is not mutated if overflow is thrown', () => {
            // Guards against the clock becoming permanently bricked or corrupted if max logical ticks are exceeded
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                clock._setTestingState(1000n, 0xFFFFn);
                
                assert.throws(() => clock.stamp(), { name: 'LiepochError' });
                
                // If state wasn't mutated, advancing the clock and stamping should succeed normally
                mockTimeMs = 1001;
                const nextStamp = clock.stamp();
                const unpacked = unpack(nextStamp);
                assert.equal(unpacked.time_ms, 1001);
                assert.equal(unpacked.logical, 0);
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('Backward drift exactly AT MAX_DRIFT_MS does not throw', () => {
            // Boundary condition: If the clock jumps backwards exactly 300000ms, it is still within the acceptable limit
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                clock._setTestingState(1000n + 300000n, 0n);
                // currentWall (1000) is exactly 300,000 behind recorded wallTime
                assert.doesNotThrow(() => clock.stamp());
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('Backward drift one millisecond OVER MAX_DRIFT_MS throws', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                clock._setTestingState(1000n + 300001n, 0n);
                assert.throws(() => clock.stamp(), { name: 'LiepochError' });
            } finally {
                Date.now = originalNow;
            }
        });
    });

    await t.test('RECEIVE', async (t) => {
        await t.test('receive() with local clock ahead: result wall time is local, logical is local + 1', () => {
            let mockTimeMs = 2000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                clock._setTestingState(2000n, 5n);
                const remote = (1000n << 16n) | 99n;
                
                const result = unpack(clock.receive(remote));
                assert.equal(result.time_ms, 2000);
                assert.equal(result.logical, 6);
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('receive() with remote clock ahead: result wall time is remote, logical is remote + 1', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                clock._setTestingState(1000n, 5n);
                const remote = (2000n << 16n) | 99n;
                
                const result = unpack(clock.receive(remote));
                assert.equal(result.time_ms, 2000);
                assert.equal(result.logical, 100);
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('receive() with equal wall times: result logical is max(local, remote) + 1', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                clock._setTestingState(1000n, 10n);
                const remote = (1000n << 16n) | 20n;
                
                const result = unpack(clock.receive(remote));
                assert.equal(result.time_ms, 1000);
                assert.equal(result.logical, 21);
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('receive() state is not mutated if overflow is thrown', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                clock._setTestingState(1000n, 0xFFFFn);
                const remote = (1000n << 16n) | 5n;
                
                // Receiving a same-millisecond stamp forces logical increment, triggering overflow
                assert.throws(() => clock.receive(remote), { name: 'LiepochError' });
                
                // Advance time and stamp to verify state wasn't bricked
                mockTimeMs = 1001;
                const nextStamp = unpack(clock.stamp());
                assert.equal(nextStamp.time_ms, 1001);
                assert.equal(nextStamp.logical, 0);
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('receive() state is not mutated if drift check throws', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                clock._setTestingState(1000n, 5n);
                const remote = ((1000n + 300001n) << 16n) | 0n;
                
                assert.throws(() => clock.receive(remote), { name: 'LiepochError' });
                
                // Ensure internal state is still 1000n, 5n by advancing time slightly and checking logical reset
                mockTimeMs = 1001;
                const nextStamp = unpack(clock.stamp());
                assert.equal(nextStamp.time_ms, 1001);
                assert.equal(nextStamp.logical, 0);
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('Forward drift exactly AT MAX_DRIFT_MS does not throw', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                const remote = ((1000n + 300000n) << 16n) | 0n;
                assert.doesNotThrow(() => clock.receive(remote));
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('Forward drift one millisecond OVER MAX_DRIFT_MS throws', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                const remote = ((1000n + 300001n) << 16n) | 0n;
                assert.throws(() => clock.receive(remote), { name: 'LiepochError' });
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('receive() accepts various correct input formats', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                const rawBigint = (2000n << 16n) | 5n;
                
                // Raw bigint
                assert.doesNotThrow(() => clock.receive(rawBigint));
                
                // serialize() hex
                assert.doesNotThrow(() => clock.receive(serialize(rawBigint)));
                
                // 0x-prefixed hex
                assert.doesNotThrow(() => clock.receive('0x' + serialize(rawBigint)));
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('receive() throws on invalid types', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                
                // @ts-ignore
                assert.throws(() => clock.receive(123), { name: 'LiepochError' });
                // @ts-ignore
                assert.throws(() => clock.receive(null), { name: 'LiepochError' });
                // @ts-ignore
                assert.throws(() => clock.receive(undefined), { name: 'LiepochError' });
                // @ts-ignore
                assert.throws(() => clock.receive({ ts: 123 }), { name: 'LiepochError' });
            } finally {
                Date.now = originalNow;
            }
        });
    });

    await t.test('BEFORE', async (t) => {
        const stampA = (1000n << 16n) | 5n;
        const stampB = (2000n << 16n) | 0n;
        const stampC = (2000n << 16n) | 1n;

        await t.test('before(a, b) true when a has smaller wall time', () => {
            assert.equal(before(stampA, stampB), true);
        });

        await t.test('before(a, b) false when a has larger wall time', () => {
            assert.equal(before(stampB, stampA), false);
        });

        await t.test('before(a, b) true when wall times equal but a has smaller logical', () => {
            assert.equal(before(stampB, stampC), true);
        });

        await t.test('before(a, b) false for equal stamps (not strictly before)', () => {
            assert.equal(before(stampB, stampB), false);
        });

        await t.test('Works with various input types', () => {
            // Two bigints
            assert.equal(before(stampA, stampB), true);
            
            // Two hex strings
            assert.equal(before(serialize(stampA), serialize(stampB)), true);
            
            // 0x-prefixed hex strings
            assert.equal(before('0x' + serialize(stampA), '0x' + serialize(stampB)), true);
            
            // Mixed inputs
            assert.equal(before(stampA, serialize(stampB)), true);
            assert.equal(before('0x' + serialize(stampA), stampB), true);
        });
    });

    await t.test('UNPACK', async (t) => {
        const testWallTime = 123456789n;
        const testLogical = 42n;
        const testStamp = (testWallTime << 16n) | testLogical;

        await t.test('Correctly extracts properties from bigint', () => {
            const result = unpack(testStamp);
            assert.equal(result.time_ms, Number(testWallTime));
            assert.equal(result.logical, Number(testLogical));
            assert.equal(result.date.getTime(), Number(testWallTime));
        });

        await t.test('Correctly extracts properties from hex string', () => {
            const result = unpack(serialize(testStamp));
            assert.equal(result.time_ms, Number(testWallTime));
            assert.equal(result.logical, Number(testLogical));
        });

        await t.test('Correctly extracts properties from 0x-prefixed hex string', () => {
            const result = unpack('0x' + serialize(testStamp));
            assert.equal(result.time_ms, Number(testWallTime));
            assert.equal(result.logical, Number(testLogical));
        });
    });

    await t.test('CAUSALITY (end-to-end scenarios)', async (t) => {
        await t.test('Three-node causal chain: A -> B -> C', () => {
            // Guards against causal drift across multiple hops when physical clocks disagree
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                // Node A is exactly on time
                const clockA = new Liepoch();
                const eventA = clockA.stamp();

                // Node B is 500ms behind A physically
                mockTimeMs = 500;
                const clockB = new Liepoch();
                const eventB = clockB.receive(eventA);

                // Node C is 1000ms behind A physically
                mockTimeMs = 0;
                const clockC = new Liepoch();
                const eventC = clockC.receive(eventB);

                assert.ok(before(eventA, eventB), 'Event B must be strictly after A');
                assert.ok(before(eventB, eventC), 'Event C must be strictly after B');
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('Concurrent events are strictly ordered after one receives the other', () => {
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clockA = new Liepoch();
                const clockB = new Liepoch();

                const eventA = clockA.stamp();
                const eventB = clockB.stamp();

                // They are concurrent (neither happened causally before the other)
                // but we test that receipt resolves order
                const reactionB = clockB.receive(eventA);
                
                assert.ok(before(eventA, reactionB), 'Reaction on B must be causally after A');
                assert.ok(before(eventB, reactionB), 'Reaction on B must be causally after its own previous event');
            } finally {
                Date.now = originalNow;
            }
        });

        await t.test('Idempotent receive: calling receive() twice with same stamp produces strictly increasing results', () => {
            // Guards against poor handling of duplicate message delivery in queues
            let mockTimeMs = 1000;
            const originalNow = Date.now;
            Date.now = () => mockTimeMs;
            try {
                const clock = new Liepoch();
                const remoteEvent = (2000n << 16n) | 0n;

                const firstReceive = clock.receive(remoteEvent);
                const secondReceive = clock.receive(remoteEvent);

                assert.ok(before(firstReceive, secondReceive), 'Second receive must advance the logical clock');
            } finally {
                Date.now = originalNow;
            }
        });
    });

});