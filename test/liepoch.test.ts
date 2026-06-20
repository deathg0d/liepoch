import test from 'node:test';
import assert from 'node:assert/strict';
import { Liepoch, LiepochError, serialize, deserialize, before, unpack } from '../src/index';

test('Liepoch Core Functionality', async (t) => {
    
    await t.test('Basic stamping advances time', () => {
        let mockTimeMs = 1718838420000;
        const originalNow = Date.now;
        Date.now = () => mockTimeMs;

        const clock = new Liepoch();
        const s1 = clock.stamp();
        mockTimeMs += 10;
        const s2 = clock.stamp();
        
        assert.ok(s1 < s2, "s2 should be strictly greater than s1");
        
        Date.now = originalNow;
    });

    await t.test('Logical clock increments on same ms', () => {
        let mockTimeMs = 1000;
        const originalNow = Date.now;
        Date.now = () => mockTimeMs;

        const clock = new Liepoch();
        const s1 = clock.stamp();
        const s2 = clock.stamp();
        
        const unpacked1 = Liepoch.unpack(s1);
        const unpacked2 = Liepoch.unpack(s2);
        
        assert.equal(unpacked1.time_ms, 1000);
        assert.equal(unpacked1.logical, 0);
        
        assert.equal(unpacked2.time_ms, 1000);
        assert.equal(unpacked2.logical, 1);
        
        Date.now = originalNow;
    });

    await t.test('Serialization and Deserialization', () => {
        const stamp = (1000n << 16n) | 5n;
        const hex = serialize(stamp);
        
        assert.equal(hex.length, 16, "Should be 16 chars long");
        assert.equal(deserialize(hex), stamp, "Deserialization should be symmetric");
        assert.equal(deserialize("0x" + hex), stamp, "Deserialization should handle 0x prefix");
        assert.equal(deserialize(hex.toUpperCase()), stamp, "Deserialization should handle uppercase hex");
        
        assert.throws(() => deserialize("not-hex"), LiepochError, "Should throw on invalid hex");
    });

    await t.test('receive() absorbs future time', () => {
        let mockTimeMs = 1000;
        const originalNow = Date.now;
        Date.now = () => mockTimeMs;

        const clock = new Liepoch();
        clock.stamp(); // internal time is now 1000, 0
        
        const remoteStamp = (1050n << 16n) | 0n; // Remote is at 1050ms
        const r1 = clock.receive(remoteStamp);
        const unpackedR1 = Liepoch.unpack(r1);
        
        assert.equal(unpackedR1.time_ms, 1050);
        assert.equal(unpackedR1.logical, 1, "Logical should increment remote logical because max == remote");
        
        Date.now = originalNow;
    });

    await t.test('receive() with same time takes max logical', () => {
        let mockTimeMs = 1000;
        const originalNow = Date.now;
        Date.now = () => mockTimeMs;

        const clock = new Liepoch();
        clock.stamp();
        clock.stamp(); // internal is 1000, 1
        
        const remoteStamp = (1000n << 16n) | 5n; // Remote is at 1000ms, logical 5
        const r2 = clock.receive(remoteStamp);
        const unpackedR2 = Liepoch.unpack(r2);
        
        assert.equal(unpackedR2.time_ms, 1000);
        assert.equal(unpackedR2.logical, 6, "Should take max(local, remote) logical + 1");
        
        Date.now = originalNow;
    });

    await t.test('Logical overflow protection', () => {
        let mockTimeMs = 1000;
        const originalNow = Date.now;
        Date.now = () => mockTimeMs;

        const clock = new Liepoch();
        clock._setTestingState(1000n, 0xFFFFn); // set to max logical
        
        assert.throws(() => clock.stamp(), LiepochError, "Should throw on overflow");
        
        Date.now = originalNow;
    });

    await t.test('Max drift protection', () => {
        let mockTimeMs = 1000;
        const originalNow = Date.now;
        Date.now = () => mockTimeMs;

        const clock = new Liepoch();
        clock.stamp();
        
        // Simulate local clock jumping back severely
        clock._setTestingState(BigInt(mockTimeMs + 300000 + 10), 0n);
        assert.throws(() => clock.stamp(), LiepochError, "Should throw on severe backward drift");

        // Forward drift from remote
        clock._setTestingState(1000n, 0n);
        const farFuture = (BigInt(mockTimeMs + 300000 + 10) << 16n) | 0n;
        assert.throws(() => clock.receive(farFuture), LiepochError, "Should throw on incoming severe forward drift");
        
        Date.now = originalNow;
    });

    await t.test('before() function handling', () => {
        const b1 = (1000n << 16n) | 5n;
        const b2 = (1000n << 16n) | 6n;
        
        assert.ok(before(b1, b2), "b1 before b2");
        assert.ok(before(serialize(b1), serialize(b2)), "string serialization before works");
        assert.ok(before("0x" + serialize(b1), serialize(b2)), "handles mixed prefixes safely");
        assert.ok(!before("0x" + serialize(b2), serialize(b1)), "handles mixed prefixes correctly for false");
    });

    await t.test('Reject JS Numbers', () => {
        const clock = new Liepoch();
        // @ts-ignore
        assert.throws(() => clock.receive(123), LiepochError, "Should reject JS Number");
    });
});