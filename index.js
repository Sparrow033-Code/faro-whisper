import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { fromString } from 'uint8arrays/from-string';
import { toString } from 'uint8arrays/to-string';
import { Uint8ArrayList } from 'uint8arraylist';

process.on('uncaughtException', (err) => {
    console.error('[FARO CRASH] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FARO CRASH] unhandledRejection:', reason);
});

const dropBoxes = new Map();
const MAX_DROPS_PER_BOX = 100;

function logStatus() {
    let totalMessages = 0;
    const boxSummaries = [];
    for (const [id, msgs] of dropBoxes.entries()) {
        totalMessages += msgs.length;
        boxSummaries.push(`${id.substring(0, 8)}(${msgs.length})`);
    }
    console.log(`[HEARTBEAT] 💓 FARO V7.5 | Buzones: ${dropBoxes.size} | Msgs: ${totalMessages} | IDs: [${boxSummaries.slice(0, 3).join(', ')}${boxSummaries.length > 3 ? '...' : ''}]`);
}

/**
 * En libp2p v3 + Yamux, el handler recibe el STREAM directamente (no {stream, connection}).
 * - Leer: for await (const chunk of stream) — el stream es async iterable
 * - Escribir: await stream.write(Uint8Array) — método del prototype AbstractStream
 * - Cerrar escritura: await stream.closeWrite()
 * - Cerrar todo: await stream.close()
 */

async function handleDropStore(stream) {
    console.log(`[Buzón] 📥 STORE handler invocado!`);
    try {
        // Leer datos del cliente (el stream es async iterable directamente)
        const bl = new Uint8ArrayList();
        for await (const chunk of stream) {
            bl.append(chunk);
            if (bl.length > 1024 * 1024) break;
        }
        const rawBytes = bl.subarray();
        console.log(`[Buzón] 📥 STORE: ${rawBytes.length} bytes leídos.`);

        if (rawBytes.length === 0) {
            console.log(`[Buzón] ⚠️ STORE: 0 bytes recibidos.`);
            try { await stream.write(fromString('ERR_EMPTY')); await stream.close(); } catch (e) { }
            return;
        }

        const rawBody = toString(rawBytes).trim();
        const spaceIdx = rawBody.indexOf(' ');
        if (spaceIdx === -1) {
            console.log(`[Buzón] ⚠️ STORE: Formato inválido.`);
            try { await stream.write(fromString('ERR_FORMAT')); await stream.close(); } catch (e) { }
            return;
        }

        const boxId = rawBody.substring(0, spaceIdx);
        const payloadB64 = rawBody.substring(spaceIdx + 1);

        if (!boxId || !payloadB64) {
            try { await stream.write(fromString('ERR_EMPTY_FIELDS')); await stream.close(); } catch (e) { }
            return;
        }

        if (!dropBoxes.has(boxId)) dropBoxes.set(boxId, []);
        const box = dropBoxes.get(boxId);
        if (box.length >= MAX_DROPS_PER_BOX) box.shift();
        box.push({ payload: payloadB64, timestamp: Date.now() });
        console.log(`[Buzón] ✅ ALMACENADO en ID: ${boxId.substring(0, 8)}... (${payloadB64.length} chars)`);

        // Responder OK y cerrar
        try {
            await stream.write(fromString('OK'));
            console.log(`[Buzón] ✅ OK enviado al cliente.`);
            await stream.close();
        } catch (e) {
            console.log(`[Buzón] ⚠️ No se pudo enviar OK: ${e.message}`);
        }
    } catch (e) {
        console.error(`[Buzón] ❌ Error STORE: ${e.message}`);
        try { await stream.write(fromString('ERR')); await stream.close(); } catch (e2) { }
    }
}

async function handleDropFetch(stream) {
    console.log(`[Buzón] 🔍 FETCH handler invocado!`);
    try {
        // Leer el boxId del cliente
        const bl = new Uint8ArrayList();
        for await (const chunk of stream) {
            bl.append(chunk);
            if (bl.length > 1024) break;
        }

        if (bl.length === 0) {
            try { await stream.write(fromString('EMPTY')); await stream.close(); } catch (e) { }
            return;
        }

        const boxId = toString(bl.subarray()).trim();
        console.log(`[Buzón] 🔍 FETCH solicitado: ${boxId.substring(0, 8)}...`);

        const box = dropBoxes.get(boxId);
        if (!box || box.length === 0) {
            try { await stream.write(fromString('EMPTY')); await stream.close(); } catch (e) { }
            return;
        }

        const allPayloads = box.map(m => m.payload).join('\n');
        box.length = 0;
        dropBoxes.delete(boxId);

        console.log(`[Buzón] 📬 ENTREGANDO drop de buzón ${boxId.substring(0, 8)}... (${allPayloads.length} chars)`);
        try { await stream.write(fromString(allPayloads)); await stream.close(); } catch (e) { }
    } catch (e) {
        console.error(`[Buzón] ❌ Error FETCH: ${e.message}`);
        try { await stream.write(fromString('EMPTY')); await stream.close(); } catch (e2) { }
    }
}

async function startFaro() {
    console.log('--- FARO v7.5 (Stream API v3 Fix) ---');
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
        transports: [webSockets()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        connectionManager: {
            maxIdleTime: 24 * 60 * 60 * 1000
        },
        services: {
            identify: identify(),
            ping: ping({ maxInboundStreams: 256, maxOutboundStreams: 256 }),
            relay: circuitRelayServer({
                reservations: { applyDefaultLimit: false, maxReservations: 1000 }
            })
        }
    });

    node.addEventListener('peer:connect', (evt) => {
        console.log(`[Red] 🤝 Conexión de: ${evt.detail.toString()}`);
    });

    // Registrar protocolos (AWAIT obligatorio en libp2p v3)
    await node.handle('/wsmp/drop/store/1.0.0', handleDropStore);
    await node.handle('/wsmp/drop/fetch/1.0.0', handleDropFetch);
    console.log(`[Faro] Protocolos registrados: ${node.getProtocols().join(', ')}`);

    await node.start();

    console.log(`🚀 FARO v7.5 ONLINE | PeerID: ${node.peerId.toString()}`);
    console.log(`🚀 Puerto ${port}`);
    const addrs = node.getMultiaddrs();
    addrs.forEach(a => console.log(`   📡 ${a.toString()}`));

    logStatus();
    setInterval(logStatus, 30000);
    setInterval(() => { console.log("[Stay-Alive] 🛡️"); }, 29 * 60 * 1000);
}

startFaro().catch(err => { console.error('❌ ERROR GLOBAL:', err); process.exit(1); });
