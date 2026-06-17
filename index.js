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
import crypto from 'crypto';

process.on('uncaughtException', (err) => {
    console.error('[FARO CRASH] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FARO CRASH] unhandledRejection:', reason);
});

const dropBoxes = new Map();
const boxTimestamps = new Map();
const MAX_DROPS_PER_BOX = 100;
const BOX_TTL_MS = 60 * 60 * 1000;

// â•â•â• Merkle Tree (transparencia) â•â•â•
const merkleLeaves = new Map(); // boxId â†’ sha256(boxId + ts)
let merkleRootHex = '0'.repeat(64);

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function buildMerkleTree() {
    const entries = Array.from(merkleLeaves.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) { merkleRootHex = '0'.repeat(64); return { root: merkleRootHex, leaves: [] }; }
    let leaves = entries.map(([id, hash]) => ({ id, hash }));
    while (leaves.length < 2 || (leaves.length & (leaves.length - 1)) !== 0) {
        leaves.push({ id: '', hash: '0'.repeat(64) });
    }
    let level = leaves.map(l => l.hash);
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            next.push(sha256(level[i] + level[i + 1]));
        }
        level = next;
    }
    merkleRootHex = level[0];
    return { root: merkleRootHex, leaves };
}

function getMerkleProof(boxId) {
    const tree = buildMerkleTree();
    const idx = tree.leaves.findIndex(l => l.id === boxId);
    if (idx === -1) return null;
    const proof = [];
    let currentIdx = idx;
    let leaves = tree.leaves.map(l => l.hash);
    while (leaves.length > 1) {
        const isRight = currentIdx % 2 === 1;
        const siblingIdx = isRight ? currentIdx - 1 : currentIdx + 1;
        if (siblingIdx < leaves.length) {
            proof.push(leaves[siblingIdx]);
        }
        currentIdx = Math.floor(currentIdx / 2);
        const next = [];
        for (let i = 0; i < leaves.length; i += 2) {
            next.push(sha256(leaves[i] + (leaves[i + 1] || '0'.repeat(64))));
        }
        leaves = next;
    }
    return { root: tree.root, proof, leafIndex: idx };
} // 1 hora

function logStatus() {
    let totalMessages = 0;
    const boxSummaries = [];
    for (const [id, msgs] of dropBoxes.entries()) {
        totalMessages += msgs.length;
        boxSummaries.push(`${id.substring(0, 8)}(${msgs.length})`);
    }
    console.log(`[HEARTBEAT] ðŸ’“ FARO v8.0 | Buzones: ${dropBoxes.size} | Msgs: ${totalMessages} | TTL: ${BOX_TTL_MS/60000}min | IDs: [${boxSummaries.slice(0, 3).join(', ')}${boxSummaries.length > 3 ? '...' : ''}]`);
}

async function streamSend(stream, data) {
    if (typeof stream.send === 'function') {
        await stream.send(data);
    } else if (typeof stream.write === 'function') {
        await stream.write(data);
    } else if (typeof stream.sink === 'function') {
        await stream.sink([data]);
    } else {
        throw new Error('Stream sin mÃ©todo de envÃ­o');
    }
}

function chunkByteLength(c) {
    if (c.byteLength !== undefined) return c.byteLength;
    if (c.length !== undefined && typeof c.length === 'number') return c.length;
    return 0;
}

/**
 * Lee un payload con formato [4B BE length][payload] del stream.
 * No depende del cierre del stream â€” lee exactamente los bytes esperados.
 * Timeout de 30s para evitar colgarse indefinidamente.
 */
async function readFramedPayload(stream, maxBytes) {
    const reader = stream.source || stream;
    const bl = new Uint8ArrayList();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; }, 30000);

    try {
        for await (const chunk of reader) {
            bl.append(chunk);
            if (bl.byteLength >= 4) break;
            if (timedOut) break;
        }
        if (timedOut) {
            console.log(`[BuzÃ³n] â±ï¸ Timeout esperando cabecera de longitud.`);
            return null;
        }
        if (bl.byteLength < 4) {
            console.log(`[BuzÃ³n] âš ï¸ Datos insuficientes (${bl.byteLength} < 4 bytes).`);
            return null;
        }

        const header = bl.subarray(0, 4);
        const payloadLength = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];

        if (payloadLength <= 0 || payloadLength > maxBytes) {
            console.log(`[BuzÃ³n] âš ï¸ Longitud invÃ¡lida: ${payloadLength} (max: ${maxBytes}).`);
            return null;
        }

        const totalExpected = 4 + payloadLength;
        if (bl.byteLength >= totalExpected) {
            return bl.subarray(4, totalExpected);
        }

        for await (const chunk of reader) {
            bl.append(chunk);
            if (bl.byteLength >= totalExpected) break;
            if (timedOut) break;
        }
        if (timedOut) {
            console.log(`[BuzÃ³n] â±ï¸ Timeout esperando payload completo.`);
            return null;
        }
        if (bl.byteLength < totalExpected) {
            console.log(`[BuzÃ³n] âš ï¸ Payload incompleto (${bl.byteLength} < ${totalExpected}).`);
            return null;
        }
        return bl.subarray(4, totalExpected);

    } catch (e) {
        console.error(`[BuzÃ³n] âŒ Error leyendo stream: ${e.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function handleDropStore(stream) {
    console.log(`[BuzÃ³n] ðŸ“¥ STORE handler invocado!`);
    try {
        const rawBytes = await readFramedPayload(stream, 1024 * 1024);
        if (!rawBytes || rawBytes.length === 0) {
            console.log(`[BuzÃ³n] âš ï¸ STORE: payload vacÃ­o o invÃ¡lido.`);
            try { await streamSend(stream, fromString('ERR_EMPTY')); await stream.close(); } catch (e) { }
            return;
        }
        console.log(`[BuzÃ³n] ðŸ“¥ STORE: ${rawBytes.length} bytes leÃ­dos.`);

        const rawBody = toString(rawBytes).trim();
        const spaceIdx = rawBody.indexOf(' ');
        if (spaceIdx === -1) {
            console.log(`[BuzÃ³n] âš ï¸ STORE: Formato invÃ¡lido.`);
            try { await streamSend(stream, fromString('ERR_FORMAT')); await stream.close(); } catch (e) { }
            return;
        }

        const boxId = rawBody.substring(0, spaceIdx);
        const payloadB64 = rawBody.substring(spaceIdx + 1);

        if (!boxId || !payloadB64) {
            try { await streamSend(stream, fromString('ERR_EMPTY_FIELDS')); await stream.close(); } catch (e) { }
            return;
        }

        if (!dropBoxes.has(boxId)) dropBoxes.set(boxId, []);
        const box = dropBoxes.get(boxId);
        if (box.length >= MAX_DROPS_PER_BOX) box.shift();
        box.push({ payload: payloadB64, timestamp: Date.now() });
        boxTimestamps.set(boxId, Date.now());

        // Merkle: registrar leaf
        merkleLeaves.set(boxId, sha256(boxId + ':' + Date.now()));
        buildMerkleTree();

        console.log(`[BuzÃ³n] âœ… ALMACENADO en ID: ${boxId.substring(0, 8)}... (${payloadB64.length} chars)`);

        try {
            await streamSend(stream, fromString('OK'));
            console.log(`[BuzÃ³n] âœ… OK enviado al cliente.`);
            await stream.close();
        } catch (e) {
            console.log(`[BuzÃ³n] âš ï¸ No se pudo enviar OK: ${e.message}`);
        }
    } catch (e) {
        console.error(`[BuzÃ³n] âŒ Error STORE: ${e.message}`);
        try { await streamSend(stream, fromString('ERR')); await stream.close(); } catch (e2) { }
    }
}

function cleanupStaleBoxes() {
    const now = Date.now();
    let cleaned = 0;
    for (const [boxId, ts] of boxTimestamps.entries()) {
        if (now - ts > BOX_TTL_MS) {
            dropBoxes.delete(boxId);
            boxTimestamps.delete(boxId);
            merkleLeaves.delete(boxId);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[LIMPIEZA] ðŸ§¹ ${cleaned} buzones expirados eliminados.`);
    }
}

async function handleMerkleRoot(stream) {
    try {
        const root = merkleRootHex;
        const data = JSON.stringify({ root, leaves: merkleLeaves.size, timestamp: Date.now() });
        try { await streamSend(stream, fromString(data)); await stream.close(); } catch (e) { }
    } catch (e) { try { await streamSend(stream, fromString('ERR')); await stream.close(); } catch (e2) { } }
}

async function handleMerkleProof(stream) {
    try {
        const rawBytes = await readFramedPayload(stream, 4096);
        if (!rawBytes || rawBytes.length === 0) {
            try { await streamSend(stream, fromString('EMPTY')); await stream.close(); } catch (e) { }
            return;
        }
        const boxId = toString(rawBytes).trim();
        const proof = getMerkleProof(boxId);
        if (!proof) {
            try { await streamSend(stream, fromString('EMPTY')); await stream.close(); } catch (e) { }
            return;
        }
        const response = JSON.stringify(proof);
        try { await streamSend(stream, fromString(response)); await stream.close(); } catch (e) { }
    } catch (e) { try { await streamSend(stream, fromString('EMPTY')); await stream.close(); } catch (e2) { } }
}

async function handleDropFetch(stream) {
    console.log(`[BuzÃ³n] ðŸ” FETCH handler invocado!`);
    try {
        const rawBytes = await readFramedPayload(stream, 4096);
        if (!rawBytes || rawBytes.length === 0) {
            console.log(`[BuzÃ³n] âš ï¸ FETCH: payload vacÃ­o.`);
            try { await streamSend(stream, fromString('EMPTY')); await stream.close(); } catch (e) { }
            return;
        }

        const boxId = toString(rawBytes).trim();
        console.log(`[BuzÃ³n] ðŸ” FETCH solicitado: ${boxId.substring(0, 8)}...`);

        const box = dropBoxes.get(boxId);
        if (!box || box.length === 0) {
            try { await streamSend(stream, fromString('EMPTY')); await stream.close(); } catch (e) { }
            return;
        }

        const allPayloads = box.map(m => m.payload).join('\n');
        box.length = 0;
        dropBoxes.delete(boxId);
        boxTimestamps.delete(boxId);
        merkleLeaves.delete(boxId);
        buildMerkleTree();

        console.log(`[BuzÃ³n] ðŸ“¬ ENTREGANDO drop de buzÃ³n ${boxId.substring(0, 8)}... (${allPayloads.length} chars)`);
        try { await streamSend(stream, fromString(allPayloads)); await stream.close(); } catch (e) { }
    } catch (e) {
        console.error(`[BuzÃ³n] âŒ Error FETCH: ${e.message}`);
        try { await streamSend(stream, fromString('EMPTY')); await stream.close(); } catch (e2) { }
    }
}

async function startFaro() {
    console.log('--- FARO v8.0 (Framed Protocol) ---');
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        try {
            privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
        } catch (e) { console.error('âŒ Error FARO_KEY:', e.message); }
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
        console.log(`[Red] ðŸ¤ ConexiÃ³n de: ${evt.detail.toString()}`);
    });

    await node.handle('/wsmp/drop/store/1.0.0', handleDropStore);
    await node.handle('/wsmp/drop/fetch/1.0.0', handleDropFetch);
    await node.handle('/wsmp/merkle/root', handleMerkleRoot);
    await node.handle('/wsmp/merkle/proof', handleMerkleProof);
    console.log(`[Faro] Protocolos: ${node.getProtocols().join(', ')}`);

    await node.start();

    console.log(`ðŸš€ FARO v8.0 ONLINE | PeerID: ${node.peerId.toString()}`);
    console.log(`ðŸš€ Puerto ${port}`);
    const addrs = node.getMultiaddrs();
    addrs.forEach(a => console.log(`   ðŸ“¡ ${a.toString()}`));

    logStatus();
    setInterval(logStatus, 30000);
    setInterval(cleanupStaleBoxes, 5 * 60 * 1000);
    setTimeout(cleanupStaleBoxes, 10000); // primera limpieza a los 10s
    setInterval(() => { console.log("[Stay-Alive] ðŸ›¡ï¸"); }, 29 * 60 * 1000);
}

startFaro().catch(err => { console.error('âŒ ERROR GLOBAL:', err); process.exit(1); });
