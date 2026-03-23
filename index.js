import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
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
import http from 'http';

const dropBoxes = new Map();
const MAX_DROPS_PER_BOX = 100;

// Servidor HTTP Híbrido (Health Check + Status + Anti-Sleep)
const httpServer = http.createServer((req, res) => {
    if (req.url === '/status') {
        let totalMessages = 0;
        const boxes = [];
        for (const [id, msgs] of dropBoxes.entries()) {
            totalMessages += msgs.length;
            boxes.push({ id: id.substring(0, 8), count: msgs.length });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: "ONLINE", version: "5.5.1", totalMessages, boxes }, null, 2));
        return;
    }
    res.writeHead(200);
    res.end("FARO V5.5.1 STAY-ALIVE ACTIVE");
});

function logStatus() {
    let totalMessages = 0;
    const boxSummaries = [];
    for (const [id, msgs] of dropBoxes.entries()) {
        totalMessages += msgs.length;
        boxSummaries.push(`${id.substring(0, 8)}(${msgs.length})`);
    }
    console.log(`[HEARTBEAT] 💓 FARO V5.5.1 | Buzones: ${dropBoxes.size} | Msgs: ${totalMessages} | IDs: [${boxSummaries.slice(0, 3).join(', ')}${boxSummaries.length > 3 ? '...' : ''}]`);
}

async function handleDropStore(data) {
    const stream = data.stream || data;
    console.log(`[Buzón] 📥 Nueva conexión STORE`);
    try {
        const chunks = [];
        for await (const chunk of stream.source) {
            chunks.push(chunk.subarray());
        }
        if (chunks.length === 0) return;

        const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        const rawBody = toString(combined).trim();
        const [boxId, payloadB64] = [rawBody.split(' ')[0], rawBody.split(' ').slice(1).join(' ')];

        if (!boxId || !payloadB64) return;

        if (!dropBoxes.has(boxId)) dropBoxes.set(boxId, []);
        const box = dropBoxes.get(boxId);
        if (box.length >= MAX_DROPS_PER_BOX) box.shift();
        box.push({ payload: payloadB64, timestamp: Date.now() });
        console.log(`[Buzón] ✅ ALMACENADO en ID: ${boxId.substring(0, 8)}...`);
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
    console.log('--- FARO v5.5.1 (Motor de Estabilidad Persistente) ---');
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        try {
            privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
        } catch (e) { console.error('❌ Error FARO_KEY:', e.message); }
    }

    httpServer.listen(port, () => {
        console.log(`🚀 HTTP Health-Check Server listening on port ${port} (Status v5.5.1)`);
    });

    const node = await createLibp2p({
        ...(privateKey ? { privateKey } : {}),
        addresses: {
            announce: [`/dns4/faro-whisper.onrender.com/tcp/443/wss`]
        },
        transports: [
            webSockets({ server: httpServer, filter: (addrs) => addrs })
        ],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        connectionManager: {
            maxIdleTime: 24 * 60 * 60 * 1000 // 24h de gracia
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
        console.log(`[Red] 🤝 Conexión establecida con: ${evt.detail.toString()}`);
    });
    node.addEventListener('peer:disconnect', (evt) => {
        console.log(`[Red] 🔌 Desconexión: ${evt.detail.toString()}`);
    });

    await node.handle('/wsmp/drop/store/1.0.0', handleDropStore);
    await node.handle('/wsmp/drop/fetch/1.0.0', handleDropFetch);

    await node.start();
    console.log(`🚀 P2P Engine ONLINE | PeerID: ${node.peerId.toString()}`);
    
    logStatus();
    setInterval(logStatus, 30000); // Audit log cada 30s

    // [STAY-ALIVE 1] Anti-Sleep de Render (cada 14 min)
    // Autismo-ping HTTP para que Render crea que hay tráfico Web real.
    setInterval(() => {
        const url = `http://localhost:${port}/status`; // Render redirige el tráfico externo aquí
        http.get(url, (res) => {}).on('error', (e) => {});
        console.log("[Stay-Alive] 🩺 Auto-audit HTTP realizado.");
    }, 14 * 60 * 1000);

    // [STAY-ALIVE 2] Gossip Heartbeat (cada 45s)
    // Mantiene la red mesh activa y propagada.
    setInterval(async () => {
        try {
            await node.services.pubsub.publish('whisper-heartbeat', fromString('KEEP_ALIVE'));
            // console.log("[Stay-Alive] 💓 Mesh Heartbeat emitido.");
        } catch (e) {}
    }, 45 * 1000);

    // [STAY-ALIVE 3] Refresh de Larga Duración (cada 29 min)
    setInterval(() => {
        console.log("[Stay-Alive] 🛡️ Ciclo de persistencia de 29m completado. El Faro sigue en linea.");
    }, 29 * 60 * 1000);
}

startFaro().catch(err => {
    console.error('❌ ERROR GLOBAL:', err);
    process.exit(1);
});
