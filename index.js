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
    console.log(`[HEARTBEAT] 💓 FARO V7.1 | Buzones: ${dropBoxes.size} | Msgs: ${totalMessages} | IDs: [${boxSummaries.slice(0, 3).join(', ')}${boxSummaries.length > 3 ? '...' : ''}]`);
}

// Función helper para leer TODOS los bytes de un stream de libp2p v3
// Maneja múltiples APIs: stream.source, stream[Symbol.asyncIterator], stream.readable
async function readAllBytes(streamObj) {
    const chunks = [];

    // Intentar obtener una fuente iterable
    let source = null;
    if (streamObj.source && typeof streamObj.source[Symbol.asyncIterator] === 'function') {
        source = streamObj.source;
    } else if (typeof streamObj[Symbol.asyncIterator] === 'function') {
        source = streamObj;
    } else if (streamObj.source && typeof streamObj.source === 'function') {
        // Algunos wrappers usan source() como función
        const s = streamObj.source();
        if (s && typeof s[Symbol.asyncIterator] === 'function') source = s;
    }

    if (source) {
        for await (const chunk of source) {
            const bytes = chunk.subarray ? chunk.subarray() : (chunk.slice ? chunk.slice() : new Uint8Array(chunk));
            chunks.push(bytes);
        }
    } else {
        // ÚLTIMO RECURSO: leer del readBuffer de yamux directamente
        console.error(`[Buzón] ⚠️ readAllBytes: sin source iterable. typeof source=${typeof streamObj.source}, constructor=${streamObj.source?.constructor?.name}`);
        // Intentar prototype chain
        let proto = Object.getPrototypeOf(streamObj);
        let depth = 0;
        while (proto && depth < 5) {
            const names = Object.getOwnPropertyNames(proto);
            console.log(`[Buzón] 🔬 proto[${depth}](${proto.constructor?.name}): ${names.join(',')}`);
            depth++;
            proto = Object.getPrototypeOf(proto);
        }
        throw new Error(`No async iterable source found. typeof source=${typeof streamObj.source}`);
    }

    if (chunks.length === 0) return new Uint8Array(0);
    const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }
    return combined;
}

// Función helper para escribir bytes a un stream
async function writeBytes(streamObj, data) {
    if (streamObj.sink && typeof streamObj.sink === 'function') {
        await streamObj.sink([data]);
    } else {
        throw new Error(`No sink function found. typeof sink=${typeof streamObj.sink}`);
    }
}

async function handleDropStore(data) {
    // En libp2p v3/yamux, data puede ser el stream directamente o {stream, connection}
    const stream = data.stream || data;
    console.log(`[Buzón] 📥 STORE | src=${typeof stream.source} srcCtor=${stream.source?.constructor?.name} asyncIter=${typeof stream[Symbol.asyncIterator]}`);
    try {
        const rawBytes = await readAllBytes(stream);
        if (rawBytes.length === 0) {
            console.log(`[Buzón] ⚠️ STORE: 0 bytes recibidos.`);
            return;
        }

        const rawBody = toString(rawBytes).trim();
        const spaceIdx = rawBody.indexOf(' ');
        if (spaceIdx === -1) {
            console.log(`[Buzón] ⚠️ STORE: Formato inválido (sin espacio). Body: ${rawBody.substring(0, 40)}...`);
            return;
        }
        const boxId = rawBody.substring(0, spaceIdx);
        const payloadB64 = rawBody.substring(spaceIdx + 1);

        if (!boxId || !payloadB64) {
            console.log(`[Buzón] ⚠️ STORE: boxId o payload vacío.`);
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
        try { if (stream.close) await stream.close(); } catch (e) {}
    }
}

async function handleDropFetch(data) {
    const stream = data.stream || data;
    console.log(`[Buzón] 🔍 FETCH | src=${typeof stream.source} srcCtor=${stream.source?.constructor?.name} asyncIter=${typeof stream[Symbol.asyncIterator]}`);
    try {
        const rawBytes = await readAllBytes(stream);
        const boxId = toString(rawBytes).trim();
        console.log(`[Buzón] 🔍 FETCH buscando: ${boxId.substring(0, 8)}...`);
        const box = dropBoxes.get(boxId);
        if (!box || box.length === 0) {
            await writeBytes(stream, fromString('EMPTY'));
            console.log(`[Buzón] 📭 Buzón ${boxId.substring(0, 8)}... vacío`);
        } else {
            const drop = box.shift();
            if (box.length === 0) dropBoxes.delete(boxId);
            await writeBytes(stream, fromString(drop.payload));
            console.log(`[Buzón] 📤 DESPACHADO: ${boxId.substring(0, 8)}... (${drop.payload.length} chars)`);
        }
    } catch (e) {
        console.error(`[Buzón] ❌ Error FETCH: ${e.message}`);
    } finally {
        try { if (stream.close) await stream.close(); } catch (e) {}
    }
}

async function startFaro() {
    console.log('--- FARO v7.1 (Stream Debug) ---');
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        try {
            privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
        } catch (e) { console.error('❌ Error FARO_KEY:', e.message); }
    }

    const node = await createLibp2p({
        ...(privateKey ? { privateKey } : {}),
        addresses: {
            listen: [`/ip4/0.0.0.0/tcp/${port}/ws`],
            announce: [`/dns4/faro-whisper.onrender.com/tcp/443/wss`]
        },
        transports: [
            webSockets()
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

    node.addEventListener('peer:connect', (evt) => {
        console.log(`[Red] 🤝 Conexión entrante de: ${evt.detail.toString()}`);
    });
    node.addEventListener('peer:disconnect', (evt) => {
        console.log(`[Red] 🔌 Desconexión: ${evt.detail.toString()}`);
    });

    await node.handle('/wsmp/drop/store/1.0.0', handleDropStore);
    await node.handle('/wsmp/drop/fetch/1.0.0', handleDropFetch);

    await node.start();
    
    console.log(`🚀 FARO v7.1 ONLINE | PeerID: ${node.peerId.toString()}`);
    console.log(`🚀 Puerto ${port} — WebSocket P2P Puro`);
    console.log(`📋 Protocolos: /wsmp/drop/store/1.0.0, /wsmp/drop/fetch/1.0.0`);
    
    const addrs = node.getMultiaddrs();
    addrs.forEach(a => console.log(`   📡 ${a.toString()}`));

    logStatus();
    setInterval(logStatus, 30000);

    setInterval(async () => {
        try {
            await node.services.pubsub.publish('whisper-heartbeat', fromString('KEEP_ALIVE'));
        } catch (e) {}
    }, 45 * 1000);

    setInterval(() => {
        console.log("[Stay-Alive] 🛡️ Ciclo de persistencia de 29m completado.");
    }, 29 * 60 * 1000);
}

startFaro().catch(err => {
    console.error('❌ ERROR GLOBAL:', err);
    process.exit(1);
});
