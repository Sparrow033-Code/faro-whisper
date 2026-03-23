import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { fromString } from 'uint8arrays/from-string';
import { toString } from 'uint8arrays/to-string';
import http from 'http';

const dropBoxes = new Map();
const MAX_DROPS_PER_BOX = 100;

// Servidor HTTP de Status para diagnóstico desde navegador
const server = http.createServer((req, res) => {
    if (req.url === '/status') {
        let totalMessages = 0;
        const boxes = [];
        for (const [id, msgs] of dropBoxes.entries()) {
            totalMessages += msgs.length;
            boxes.push({ id: id.substring(0, 8), count: msgs.length });
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: "ONLINE",
            version: "5.1",
            totalBoxes: dropBoxes.size,
            totalMessages,
            boxes,
            time: new Date().toISOString()
        }, null, 2));
        return;
    }
    res.writeHead(404);
    res.end("Use /status");
});

function logStatus() {
    let totalMessages = 0;
    for (const box of dropBoxes.values()) totalMessages += box.length;
    console.log(`[HEARTBEAT] 💓 FARO V5.1 | Buzones: ${dropBoxes.size} | Msgs: ${totalMessages} | Time: ${new Date().toLocaleTimeString()}`);
}

async function handleDropStore(data) {
    // Handler universal: acepta objeto {stream} o stream directo
    const stream = data.stream || data;
    const connection = data.connection || {};
    const remotePeer = connection.remotePeer?.toString()?.substring(0, 8) || 'unknown';

    console.log(`[Buzón] 📥 Nueva conexión STORE desde: ${remotePeer}`);
    try {
        const chunks = [];
        for await (const chunk of stream.source) {
            chunks.push(chunk.subarray());
        }
        
        if (chunks.length === 0) {
            console.warn(`[Buzón] ⚠️ Stream STORE vacío de ${remotePeer}`);
            return;
        }

        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        const rawBody = toString(combined).trim();
        const parts = rawBody.split(' ');
        const boxId = parts[0];
        const payload = parts.slice(1).join(' ');

        if (!boxId || !payload) {
            console.error(`[Buzón] ❌ Mal formado: ID=${boxId}, PayloadSize=${payload?.length}`);
            return;
        }

        if (!dropBoxes.has(boxId)) dropBoxes.set(boxId, []);
        const box = dropBoxes.get(boxId);
        if (box.length >= MAX_DROPS_PER_BOX) box.shift();
        
        box.push({ payload, timestamp: Date.now() });
        console.log(`[Buzón] ✅ ALMACENADO en ID: ${boxId.substring(0, 8)}...`);
    } catch (e) {
        console.error(`[Buzón] ❌ Error STORE: ${e.message}`);
    } finally {
        try { await stream.close(); } catch (e) {}
    }
}

async function handleDropFetch(data) {
    const stream = data.stream || data;
    const connection = data.connection || {};
    const remotePeer = connection.remotePeer?.toString()?.substring(0, 8) || 'unknown';

    console.log(`[Buzón] 🔍 Nueva conexión FETCH desde: ${remotePeer}`);
    try {
        const chunks = [];
        for await (const chunk of stream.source) {
            chunks.push(chunk.subarray());
        }
        
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        const boxId = toString(combined).trim();
        console.log(`[Buzón] 🔍 Solicitud para ID: ${boxId.substring(0, 8)}...`);

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
    console.log('--- FARO v5.1 (Status HTTP + Handler Universal) ---');
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        try {
            privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
        } catch (e) {
            console.error('❌ Error FARO_KEY:', e.message);
        }
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
    console.log(`🚀 FARO v5.1 ONLINE | PeerID: ${node.peerId.toString()}`);
    
    // Arrancar servidor HTTP para auditoría
    server.listen(port, () => {
        console.log(`🌐 Status Web: https://faro-whisper.onrender.com/status`);
    });

    setInterval(logStatus, 5000);
}

startFaro().catch(err => {
    console.error('❌ ERROR GLOBAL:', err);
    process.exit(1);
});
