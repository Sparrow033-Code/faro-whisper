import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@libp2p/gossipsub';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { fromString } from 'uint8arrays/from-string';
import { toString } from 'uint8arrays/to-string';

const dropBoxes = new Map();
const MAX_DROPS_PER_BOX = 100;

function logStatus() {
    let totalMessages = 0;
    const boxSummaries = [];
    for (const [id, msgs] of dropBoxes.entries()) {
        totalMessages += msgs.length;
        boxSummaries.push(`${id.substring(0, 8)}(${msgs.length})`);
    }
    console.log(`[HEARTBEAT] 💓 FARO V7.0 | Buzones: ${dropBoxes.size} | Msgs: ${totalMessages} | IDs: [${boxSummaries.slice(0, 3).join(', ')}${boxSummaries.length > 3 ? '...' : ''}]`);
}

async function handleDropStore(data) {
    const stream = data.stream || data;
    console.log(`[Buzón] 📥 Nueva conexión STORE`);
    try {
        const chunks = [];
        for await (const chunk of stream.source) {
            chunks.push(chunk.subarray());
        }
        if (chunks.length === 0) {
            console.log(`[Buzón] ⚠️ STORE: 0 chunks recibidos.`);
            return;
        }

        const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        const rawBody = toString(combined).trim();
        const [boxId, payloadB64] = [rawBody.split(' ')[0], rawBody.split(' ').slice(1).join(' ')];

        if (!boxId || !payloadB64) {
            console.log(`[Buzón] ⚠️ STORE: Formato inválido (boxId o payload vacío).`);
            return;
        }

        if (!dropBoxes.has(boxId)) dropBoxes.set(boxId, []);
        const box = dropBoxes.get(boxId);
        if (box.length >= MAX_DROPS_PER_BOX) box.shift();
        box.push({ payload: payloadB64, timestamp: Date.now() });
        console.log(`[Buzón] ✅ ALMACENADO en ID: ${boxId.substring(0, 8)}... (${payloadB64.length} chars)`);
    } catch (e) {
        console.error(`[Buzón] ❌ Error STORE: ${e.message}`);
    } finally {
        try { await stream.close(); } catch (e) {}
    }
}

async function handleDropFetch(data) {
    const stream = data.stream || data;
    console.log(`[Buzón] 🔍 Nueva conexión FETCH`);
    try {
        const chunks = [];
        for await (const chunk of stream.source) {
            chunks.push(chunk.subarray());
        }
        const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        const boxId = toString(combined).trim();
        console.log(`[Buzón] 🔍 FETCH solicitado: ${boxId.substring(0, 8)}...`);
        const box = dropBoxes.get(boxId);
        if (!box || box.length === 0) {
            await stream.sink([fromString('EMPTY')]);
        } else {
            const drop = box.shift();
            if (box.length === 0) dropBoxes.delete(boxId);
            await stream.sink([fromString(drop.payload)]);
            console.log(`[Buzón] 📤 DESPACHADO: ${boxId.substring(0, 8)}...`);
        }
    } catch (e) {
        console.error(`[Buzón] ❌ Error FETCH: ${e.message}`);
    } finally {
        try { await stream.close(); } catch (e) {}
    }
}

async function startFaro() {
    console.log('--- FARO v7.0 (WebSocket Puro — Sin httpServer) ---');
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        try {
            privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
        } catch (e) { console.error('❌ Error FARO_KEY:', e.message); }
    }

    // [FIX v7.0] Eliminado httpServer completamente.
    // libp2p crea su propio servidor WebSocket interno.
    // Esto garantiza que los upgrades WS se procesan correctamente por libp2p.
    const node = await createLibp2p({
        ...(privateKey ? { privateKey } : {}),
        addresses: {
            listen: [`/ip4/0.0.0.0/tcp/${port}/ws`],
            announce: [`/dns4/faro-whisper.onrender.com/tcp/443/wss`]
        },
        transports: [
            webSockets()  // SIN server option — libp2p gestiona todo
        ],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        connectionManager: {
            maxIdleTime: 24 * 60 * 60 * 1000
        },
        services: {
            identify: identify(),
            ping: ping(),
            pubsub: gossipsub({ allowPublishToZeroPeers: true }),
            relay: circuitRelayServer({ reservations: { applyDefaultLimit: false } }),
            dht: kadDHT({ protocol: '/wsmp/kad/1.0.0' })
        }
    });

    // Logs de conexión para depuración
    node.addEventListener('peer:connect', (evt) => {
        console.log(`[Red] 🤝 Conexión entrante de: ${evt.detail.toString()}`);
    });
    node.addEventListener('peer:disconnect', (evt) => {
        console.log(`[Red] 🔌 Desconexión: ${evt.detail.toString()}`);
    });

    await node.handle('/wsmp/drop/store/1.0.0', handleDropStore);
    await node.handle('/wsmp/drop/fetch/1.0.0', handleDropFetch);

    await node.start();
    
    console.log(`🚀 FARO v7.0 ONLINE | PeerID: ${node.peerId.toString()}`);
    console.log(`🚀 Puerto ${port} — WebSocket P2P Puro (sin httpServer intermediario)`);
    console.log(`📋 Protocolos registrados: /wsmp/drop/store/1.0.0, /wsmp/drop/fetch/1.0.0`);
    
    const addrs = node.getMultiaddrs();
    addrs.forEach(a => console.log(`   📡 ${a.toString()}`));

    logStatus();
    setInterval(logStatus, 30000);

    // [STAY-ALIVE 2] Gossip Heartbeat (cada 45s)
    setInterval(async () => {
        try {
            await node.services.pubsub.publish('whisper-heartbeat', fromString('KEEP_ALIVE'));
        } catch (e) {}
    }, 45 * 1000);

    // [STAY-ALIVE 3] Log de persistencia (cada 29 min)
    setInterval(() => {
        console.log("[Stay-Alive] 🛡️ Ciclo de persistencia de 29m completado. El Faro sigue en linea.");
    }, 29 * 60 * 1000);
}

startFaro().catch(err => {
    console.error('❌ ERROR GLOBAL:', err);
    process.exit(1);
});
