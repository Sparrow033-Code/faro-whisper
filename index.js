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
    console.log(`[HEARTBEAT] 馃挀 FARO V7.2 | Buzones: ${dropBoxes.size} | Msgs: ${totalMessages} | IDs: [${boxSummaries.slice(0, 3).join(', ')}${boxSummaries.length > 3 ? '...' : ''}]`);
}

// Funci贸n helper para leer TODOS los bytes de un stream de libp2p v3
// Maneja m煤ltiples APIs: stream.source, stream[Symbol.asyncIterator], stream.readable
async function readAllBytes(streamObj) {
    const chunks = [];

    // Intentar obtener una fuente iterable
    let source = null;
    if (streamObj.source && typeof streamObj.source[Symbol.asyncIterator] === 'function') {
        source = streamObj.source;
    } else if (typeof streamObj[Symbol.asyncIterator] === 'function') {
        source = streamObj;
    } else if (streamObj.source && typeof streamObj.source === 'function') {
        // Algunos wrappers usan source() como funci贸n
        const s = streamObj.source();
        if (s && typeof s[Symbol.asyncIterator] === 'function') source = s;
    }

    if (source) {
        for await (const chunk of source) {
            const bytes = chunk.subarray ? chunk.subarray() : (chunk.slice ? chunk.slice() : new Uint8Array(chunk));
            chunks.push(bytes);
        }
    } else {
        // 脷LTIMO RECURSO: leer del readBuffer de yamux directamente
        console.error(`[Buz贸n] 鈿狅笍 readAllBytes: sin source iterable. typeof source=${typeof streamObj.source}, constructor=${streamObj.source?.constructor?.name}`);
        // Intentar prototype chain
        let proto = Object.getPrototypeOf(streamObj);
        let depth = 0;
        while (proto && depth < 5) {
            const names = Object.getOwnPropertyNames(proto);
            console.log(`[Buz贸n] 馃敩 proto[${depth}](${proto.constructor?.name}): ${names.join(',')}`);
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

// Funci贸n helper para escribir bytes a un stream (libp2p v3 compatible)
async function writeBytes(streamObj, data) {
    // M茅todo 1: .sink (libp2p cl谩sico)
    if (streamObj.sink && typeof streamObj.sink === 'function') {
        await streamObj.sink([data]);
        return;
    }
    // M茅todo 2: .write (AbstractStream newer API)
    if (typeof streamObj.write === 'function') {
        await streamObj.write(data);
        return;
    }
    // M茅todo 3: Web Streams API (.writable)
    if (streamObj.writable && typeof streamObj.writable.getWriter === 'function') {
        const writer = streamObj.writable.getWriter();
        await writer.write(data);
        writer.releaseLock();
        return;
    }
    // M茅todo 4: sendData / push
    if (typeof streamObj.push === 'function') {
        streamObj.push(data);
        return;
    }
    // FALLBACK: volcar prototype chain para debugging
    let proto = Object.getPrototypeOf(streamObj);
    let depth = 0;
    while (proto && depth < 5) {
        const names = Object.getOwnPropertyNames(proto);
        console.log(`[Buz贸n] 馃敩 WRITE proto[${depth}](${proto.constructor?.name}): ${names.join(',')}`);
        depth++;
        proto = Object.getPrototypeOf(proto);
    }
    throw new Error(`No write method found. write=${typeof streamObj.write} writable=${typeof streamObj.writable} push=${typeof streamObj.push}`);
}

async function handleDropStore(data) {
    console.log(`[Buz贸n] 馃摜 STORE handler invocado!`);
    // En libp2p v3/yamux, data puede ser el stream directamente o {stream, connection}
    const stream = data.stream || data;
    console.log(`[Buz贸n] 馃摜 STORE | src=${typeof stream.source} srcCtor=${stream.source?.constructor?.name} asyncIter=${typeof stream[Symbol.asyncIterator]}`);
    try {
        const rawBytes = await readAllBytes(stream);
        console.log(`[Buz贸n] 馃摜 STORE: ${rawBytes.length} bytes le铆dos del stream`);
        if (rawBytes.length === 0) {
            console.log(`[Buz贸n] 鈿狅笍 STORE: 0 bytes recibidos.`);
            try { await writeBytes(stream, fromString('ERR_EMPTY')); } catch(e) {}
            return;
        }

        const rawBody = toString(rawBytes).trim();
        const spaceIdx = rawBody.indexOf(' ');
        if (spaceIdx === -1) {
            console.log(`[Buz贸n] 鈿狅笍 STORE: Formato inv谩lido (sin espacio). Body: ${rawBody.substring(0, 60)}...`);
            try { await writeBytes(stream, fromString('ERR_FORMAT')); } catch(e) {}
            return;
        }
        const boxId = rawBody.substring(0, spaceIdx);
        const payloadB64 = rawBody.substring(spaceIdx + 1);

        if (!boxId || !payloadB64) {
            console.log(`[Buz贸n] 鈿狅笍 STORE: boxId o payload vac铆o.`);
            try { await writeBytes(stream, fromString('ERR_EMPTY_FIELDS')); } catch(e) {}
            return;
        }

        if (!dropBoxes.has(boxId)) dropBoxes.set(boxId, []);
        const box = dropBoxes.get(boxId);
        if (box.length >= MAX_DROPS_PER_BOX) box.shift();
        box.push({ payload: payloadB64, timestamp: Date.now() });
        console.log(`[Buz贸n] 鉁?ALMACENADO en ID: ${boxId.substring(0, 8)}... (${payloadB64.length} chars)`);

        // Enviar confirmaci贸n al cliente
        try { await writeBytes(stream, fromString('OK')); } catch(e) {
            console.log(`[Buz贸n] 鈿狅笍 No se pudo enviar OK (stream ya cerrado): ${e.message}`);
        }
    } catch (e) {
        console.error(`[Buz贸n] 鉂?Error STORE: ${e.message}`);
    } finally {
        try { if (stream.close) await stream.close(); } catch (e) {}
    }
}

async function handleDropFetch(data) {
    const stream = data.stream || data;
    console.log(`[Buz贸n] 馃攳 FETCH | src=${typeof stream.source} srcCtor=${stream.source?.constructor?.name} asyncIter=${typeof stream[Symbol.asyncIterator]}`);
    try {
        const rawBytes = await readAllBytes(stream);
        const boxId = toString(rawBytes).trim();
        console.log(`[Buz贸n] 馃攳 FETCH buscando: ${boxId.substring(0, 8)}...`);
        const box = dropBoxes.get(boxId);
        if (!box || box.length === 0) {
            await writeBytes(stream, fromString('EMPTY'));
            console.log(`[Buz贸n] 馃摥 Buz贸n ${boxId.substring(0, 8)}... vac铆o`);
        } else {
            const drop = box.shift();
            if (box.length === 0) dropBoxes.delete(boxId);
            await writeBytes(stream, fromString(drop.payload));
            console.log(`[Buz贸n] 馃摛 DESPACHADO: ${boxId.substring(0, 8)}... (${drop.payload.length} chars)`);
        }
    } catch (e) {
        console.error(`[Buz贸n] 鉂?Error FETCH: ${e.message}`);
    } finally {
        try { if (stream.close) await stream.close(); } catch (e) {}
    }
}

async function startFaro() {
    console.log('--- FARO v7.2 (STORE Confirmation) ---');
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        try {
            privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
        } catch (e) { console.error('鉂?Error FARO_KEY:', e.message); }
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
        console.log(`[Red] 馃 Conexi贸n entrante de: ${evt.detail.toString()}`);
    });
    node.addEventListener('peer:disconnect', (evt) => {
        console.log(`[Red] 馃攲 Desconexi贸n: ${evt.detail.toString()}`);
    });

    await node.handle('/wsmp/drop/store/1.0.0', handleDropStore);
    await node.handle('/wsmp/drop/fetch/1.0.0', handleDropFetch);

    await node.start();
    
    console.log(`馃殌 FARO v7.2 ONLINE | PeerID: ${node.peerId.toString()}`);
    console.log(`馃殌 Puerto ${port} 鈥?WebSocket P2P Puro`);
    console.log(`馃搵 Protocolos: /wsmp/drop/store/1.0.0, /wsmp/drop/fetch/1.0.0`);
    
    const addrs = node.getMultiaddrs();
    addrs.forEach(a => console.log(`   馃摗 ${a.toString()}`));

    logStatus();
    setInterval(logStatus, 30000);

    setInterval(async () => {
        try {
            await node.services.pubsub.publish('whisper-heartbeat', fromString('KEEP_ALIVE'));
        } catch (e) {}
    }, 45 * 1000);

    setInterval(() => {
        console.log("[Stay-Alive] 馃洝锔?Ciclo de persistencia de 29m completado.");
    }, 29 * 60 * 1000);
}

startFaro().catch(err => {
    console.error('鉂?ERROR GLOBAL:', err);
    process.exit(1);
});
