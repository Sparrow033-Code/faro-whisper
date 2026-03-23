import http from 'http';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { fromString } from 'uint8arrays/from-string';
import { toString } from 'uint8arrays/to-string';

// ==========================================
// ALMACÉN DE BOLSAS (Buzón Ciego)
// ==========================================
const dropBoxes = new Map();
const MAX_DROPS_PER_BOX = 50;
const DROP_TTL_MS = 24 * 60 * 60 * 1000;

function cleanExpiredDrops() {
    const now = Date.now();
    for (const [boxId, drops] of dropBoxes.entries()) {
        const valid = drops.filter(d => (now - d.timestamp) < DROP_TTL_MS);
        if (valid.length === 0) dropBoxes.delete(boxId);
        else dropBoxes.set(boxId, valid);
    }
}

// ==========================================
// SERVIDOR HTTP DE DIAGNÓSTICO
// ==========================================
// Render requiere un servidor HTTP para health checks. Aprovechamos para diagnóstico.
const diagServer = http.createServer((req, res) => {
    if (req.url === '/status') {
        const list = Array.from(dropBoxes.entries()).map(([id, drops]) => ({
            boxId: id,
            count: drops.length,
            lastUpdate: drops[drops.length-1].timestamp
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ v: '4.5', activeBoxes: list }, null, 2));
    } else {
        res.writeHead(200);
        res.end('FARO v4.5 ONLINE');
    }
});

// ==========================================
// HANDLERS P2P
// ==========================================
function handleDropStore(data) {
    const { stream } = data;
    const chunks = [];
    const reader = async () => {
        try {
            for await (const chunk of stream.source) {
                chunks.push(chunk.subarray());
            }
            const message = toString(new Uint8Array(Buffer.concat(chunks)));
            const spaceIdx = message.indexOf(' ');
            if (spaceIdx === -1) return;

            const boxId = message.substring(0, spaceIdx);
            const payload = message.substring(spaceIdx + 1);

            if (!dropBoxes.has(boxId)) dropBoxes.set(boxId, []);
            const box = dropBoxes.get(boxId);
            if (box.length >= MAX_DROPS_PER_BOX) box.shift();
            box.push({ payload, timestamp: Date.now() });

            console.log(`[Buzón] 📥 Drop guardado: ${boxId.substring(0, 8)}`);
        } catch (e) {}
    };
    reader();
}

function handleDropFetch(data) {
    const { stream } = data;
    const chunks = [];
    const reader = async () => {
        try {
            for await (const chunk of stream.source) {
                chunks.push(chunk.subarray());
            }
            const boxId = toString(new Uint8Array(Buffer.concat(chunks))).trim();
            if (!boxId) {
                await stream.sink([fromString('EMPTY')]);
                return;
            }

            const box = dropBoxes.get(boxId);
            if (!box || box.length === 0) {
                console.log(`[Buzón] 🔍 FETCH vacío: ${boxId.substring(0, 8)}`);
                await stream.sink([fromString('EMPTY')]);
                return;
            }

            const drop = box.shift();
            if (box.length === 0) dropBoxes.delete(boxId);

            console.log(`[Buzón] 📤 Drop entregado: ${boxId.substring(0, 8)}`);
            await stream.sink([fromString(drop.payload)]);
        } catch (e) {}
    };
    reader();
}

// ==========================================
// ARRANQUE
// ==========================================
async function startFaro() {
    console.log('--- FARO v4.5 (Diagnostic Mode) ---');
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
    }

    const node = await createLibp2p({
        ...(privateKey ? { privateKey } : {}),
        addresses: {
            listen: [`/ip4/0.0.0.0/tcp/${port}/ws`],
            announce: [`/dns4/faro-whisper.onrender.com/tcp/443/wss`]
        },
        transports: [tcp(), webSockets({ filter: (addrs) => addrs })],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify(),
            ping: ping(),
            relay: circuitRelayServer({ reservations: { applyDefaultLimit: false } }),
            dht: kadDHT({ protocol: '/wsmp/kad/1.0.0' })
        }
    });

    await node.handle('/wsmp/drop/store/1.0.0', handleDropStore);
    await node.handle('/wsmp/drop/fetch/1.0.0', handleDropFetch);

    await node.start();
    diagServer.listen(port); // Compartimos puerto

    console.log(`🚀 FARO v4.5 ONLINE en ${node.peerId.toString()}`);
    setInterval(cleanExpiredDrops, 3600000);
}

startFaro().catch(console.error);
