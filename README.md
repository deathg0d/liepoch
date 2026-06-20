# liepoch

**Distributed timestamps that actually mean something.**

Timestamps in distributed systems are lies. Two machines clock a simultaneous event, and due to NTP drift, one says it happened 47 milliseconds before the other. This breaks log causality, scrambles trace ordering, and silently destroys data in Last-Write-Wins databases.

`liepoch` is a zero-dependency, zero-ceremony **Hybrid Logical Clock (HLC)** for Node.js and TypeScript. It packs a physical timestamp and a logical causality counter into a single 64-bit integer, serialized as a safe, universally sortable string. 

If `liepoch` becomes the standard, suddenly all your microservices, background workers, and distributed databases speak the exact same temporal language.

## Installation

```bash
npm install liepoch
```

[![npm version](https://badge.fury.io/js/liepoch.svg)](https://badge.fury.io/js/liepoch)

## The "Zero Ceremony" Guarantees
Every distributed system rolls its own HLC, usually with fatal edge cases. `liepoch` is designed to be a foolproof drop-in primitive:
* **JSON Safe:** Returns fixed-width hex strings (`"0000018f2a1b0001"`). No `TypeError: Do not know how to serialize a BigInt` crashes.
* **Database Safe:** Because they are zero-padded 16-character strings, they **sort natively and correctly** in standard `VARCHAR` columns, MongoDB strings, and Redis sorted sets without needing custom comparison logic.
* **Type Safe:** Explicitly rejects standard JavaScript `Number` types (like `Date.now()`) to prevent silent precision loss beyond 53 bits.
* **Drift Protected:** Bounds severe backward NTP drift and malicious future-dated messages.

---

## Quick Start

By default, `liepoch` exports a singleton. You use `stamp()` when an event happens, and `receive()` when you get a message from another machine.

### Service A (The Sender)
```typescript
import { stamp } from 'liepoch';

app.post('/checkout', (req, res) => {
    // Generate a causal timestamp for this event
    const eventTime = stamp(); 
    
    // Send to Kafka/RabbitMQ/Redis/etc
    messageQueue.publish('orders', {
        id: 'order_123',
        _causality: eventTime, 
        data: req.body
    });
});
```

### Service B (The Receiver)
```typescript
import { receive } from 'liepoch';

messageQueue.subscribe('orders', (msg) => {
    // Absorb the timestamp from Service A.
    // If Service B's physical clock is running slightly slow, 
    // receive() forces Service B's clock into the correct causal future.
    const localTime = receive(msg._causality);
    
    // localTime is strictly causally > msg._causality
    db.save({
        ...msg.data,
        updated_at: localTime 
    });
});
```

---

## Use Cases

### 1. Correcting Microservice Logs (No More Time Travel)
If Service A logs an event, forwards it to Worker B, and Worker B's clock is 15ms behind, standard logs will show the worker processing the event *before* the user even clicked the button. 

By passing `liepoch` timestamps between services via HTTP headers or queue payloads, and calling `receive()` on the worker, cause will **always** sort strictly before effect in Datadog, Splunk, or ElasticSearch.

### 2. Preventing Silent Data Loss (Last-Write-Wins)
In a distributed database (Cassandra, DynamoDB, or multi-writer Postgres), conflict resolution often relies on timestamps. If a user updates their profile on a server with a fast clock, and immediately fixes a typo on a server with an accurate clock, the database will incorrectly keep the older data because its physical timestamp is higher.

Using `liepoch` ensures that the second write is causally stamped higher than the first write, preserving the user's intent perfectly.

### 3. Same-Millisecond Collisions
If a busy Node.js loop processes 50 events in a single millisecond, `Date.now()` gives them all the exact same timestamp. When saved to a database, their order is permanently lost. 

`liepoch` uses the bottom 16 bits as a logical counter. All 50 events get the same physical time, but mathematically unique, strictly incrementing logical counters. Order is preserved flawlessly.

---

## API Reference

### `stamp(): string`
Generates a new timestamp string representing "now". Call this when a local event occurs.

### `receive(incoming: string | bigint): string`
Absorbs a remote timestamp, ensuring the local clock advances past it. Call this whenever you receive a message/request from another node.

### `before(a: string | bigint, b: string | bigint): boolean`
Returns `true` if event `a` happened causally before event `b`. Safely handles mixed inputs (raw hex, `0x`-prefixed hex, or BigInts).

### `unpack(stamp: string | bigint): { time_ms: number, logical: number, date: Date }`
Unpacks a `liepoch` timestamp into its physical millisecond time and its logical counter. Useful for human-readable debugging.

### `clock: Liepoch`
The underlying singleton instance. You can instantiate your own (`new Liepoch()`) if you need isolated clocks for unit testing, but 99% of applications should use the default singleton to maintain correct causality across the entire Node process.

---

## How it works under the hood

A `liepoch` timestamp is a 64-bit integer:
* **Top 48 bits**: Physical wall-clock time in milliseconds since the UNIX epoch (safe until the year 10,889 AD).
* **Bottom 16 bits**: Logical counter (allows 65,536 causal events within the exact same millisecond).

Because 64-bit integers lose precision in JavaScript's floating-point numbers, the public API deals entirely in 16-character, zero-padded hex strings. 

```
0000018f2a1b0001
[ time ms  ][log]
```

## Ephemeral State & Restarts
The singleton's state resides in memory. If your Node process crashes and restarts, it forgets its previous logical state. To guarantee absolute causality across process restarts in a high-throughput microservice, you should fetch the last known `liepoch` timestamp for this node from your database/store on boot, and pass it to `receive()` before processing new events.

## License
MIT
