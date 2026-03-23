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

const dropBoxes = new Map();
const MAX_DROPS_PER_BOX = 100;

function logStatus() {
    let totalMessages = 0;
    for (const box of dropBoxes.values()) totalMessages += box.length;
    console.log(`[HEARTBEAT] 💓 FARO V4.9 | Buzones: ${dropBoxes.size} | Msgs: ${totalMessages} | Time: ${new Date().toLocaleTimeString()}`);
}

async function handleDropStore({ stream }) {
    console.log(`[Buzón] 📥 >>> RECIBIENDO STORE...`);
    try {
        const chunks = [];
        for await (const chunk of stream.source) {
            chunks.push(chunk.subarray());
        }
        const rawBody = toString(new Uint8Array(Buffer.concat(chunks)));
        const parts = rawBody.split(' ');
        const boxId = parts[0];
        const payload = parts.slice(1).join(' ');

        if (!boxId || !payload) {
            console.error(`[Buzón] ❌ Malformed: ID=${boxId}, Size=${payload?.length}`);
            return;
        }

        if (!dropBoxes.has(boxId)) dropBoxes.set(boxId, []);
        const box = dropBoxes.get(boxId);
        if (box.length >= MAX_DROPS_PER_BOX) box.shift();
        box.push({ payload, timestamp: Date.now() });

        console.log(`[Buzón] ✅ ALMACENADO en ID: ${boxId}`);
    } catch (e) {
        console.error(`[Buzón] ❌ Error crítico STORE: ${e.message}`);
    }
}

async function handleDropFetch({ stream }) {
    console.log(`[Buzón] 🔍 >>> RECIBIENDO FETCH...`);
    try {
        const chunks = [];
        for await (const chunk of stream.source) {
            chunks.push(chunk.subarray());
        }
        const boxId = toString(new Uint8Array(Buffer.concat(chunks))).trim();
        console.log(`[Buzón] 🔍 Solicitud para ID: ${boxId}`);

        const box = dropBoxes.get(boxId);
        if (!box || box.length === 0) {
            console.log(`[Buzón] 💨 Vacío: ${boxId}`);
            await stream.sink([fromString('EMPTY')]);
            return;
        }

        const drop = box.shift();
        if (box.length === 0) dropBoxes.delete(boxId);

        console.log(`[Buzón] 📤 DESPACHADO: ${boxId}`);
        await stream.sink([fromString(drop.payload)]);
    } catch (e) {
        console.error(`[Buzón] ❌ Error crítico FETCH: ${e.message}`);
    }
}

async function startFaro() {
    console.log('--- FARO v4.9 (Omnisciente + Latido 5s) ---');
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        try {
            privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
        } catch (e) {}
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

    node.addEventListener('peer:connect', (evt) => {
        console.log(`[P2P] 🔌 Nueva conexión: ${evt.detail.toString()}`);
    });

    await node.start();
    console.log(`🚀 FARO v4.9 ONLINE | PeerID: ${node.peerId.toString()}`);
    
    // Latido ultrarrápido para forzar vaciado de logs en Render
    setInterval(logStatus, 5000);
}

startFaro().catch(err => {
    console.error('❌ ERROR GLOVAL:', err);
    process.exit(1);
});
