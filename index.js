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

const dropBoxes = new Map();
const MAX_DROPS_PER_BOX = 100;

function logStatus() {
    let totalMessages = 0;
    for (const box of dropBoxes.values()) totalMessages += box.length;
    console.log(`[HEARTBEAT] 💓 FARO V5.0 | Buzones: ${dropBoxes.size} | Msgs: ${totalMessages} | Time: ${new Date().toLocaleTimeString()}`);
}

async function handleDropStore({ stream, connection }) {
    const peerId = connection.remotePeer.toString().substring(0, 8);
    console.log(`[Buzón] 📥 Nueva conexión STORE desde: ${peerId}`);
    try {
        const chunks = [];
        for await (const chunk of stream.source) {
            console.log(`[Buzón] 📦 Recibido chunk de ${peerId}: ${chunk.length} bytes`);
            chunks.push(chunk.subarray());
        }
        
        if (chunks.length === 0) {
            console.warn(`[Buzón] ⚠️ Stream STORE cerrado sin datos desde ${peerId}`);
            return;
        }

        // Combinar chunks manualmente para evitar problemas de Buffer.concat
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
            console.error(`[Buzón] ❌ Formato inválido desde ${peerId}: ID=${boxId}, PayloadSize=${payload?.length}`);
            return;
        }

        if (!dropBoxes.has(boxId)) dropBoxes.set(boxId, []);
        const box = dropBoxes.get(boxId);
        if (box.length >= MAX_DROPS_PER_BOX) box.shift();
        
        box.push({ payload, timestamp: Date.now() });
        console.log(`[Buzón] ✅ ALMACENADO en ID: ${boxId} (Remitente: ${peerId})`);
    } catch (e) {
        console.error(`[Buzón] ❌ Error crítico STORE (${peerId}): ${e.message}`);
    } finally {
        try { await stream.close(); } catch (e) {}
    }
}

async function handleDropFetch({ stream, connection }) {
    const peerId = connection.remotePeer.toString().substring(0, 8);
    console.log(`[Buzón] 🔍 Nueva conexión FETCH desde: ${peerId}`);
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
        console.log(`[Buzón] 🔍 Solicitud de ${peerId} para ID: ${boxId}`);

        const box = dropBoxes.get(boxId);
        if (!box || box.length === 0) {
            console.log(`[Buzón] 💨 Vacío: ${boxId}`);
            await stream.sink([fromString('EMPTY')]);
        } else {
            const drop = box.shift();
            if (box.length === 0) dropBoxes.delete(boxId);
            console.log(`[Buzón] 📤 DESPACHADO: ${boxId} -> ${peerId}`);
            await stream.sink([fromString(drop.payload)]);
        }
    } catch (e) {
        console.error(`[Buzón] ❌ Error crítico FETCH (${peerId}): ${e.message}`);
    } finally {
        try { await stream.close(); } catch (e) {}
    }
}

async function startFaro() {
    console.log('--- FARO v5.0 (Hyper-Logs + Robustez) ---');
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        try {
            privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
        } catch (e) {
            console.error('❌ Error cargando FARO_KEY:', e.message);
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

    node.addEventListener('peer:connect', (evt) => {
        console.log(`[P2P] 🔌 Conectado a: ${evt.detail.toString().substring(0, 15)}...`);
    });

    await node.start();
    console.log(`🚀 FARO v5.0 ONLINE | PeerID: ${node.peerId.toString()}`);
    
    setInterval(logStatus, 5000);
}

startFaro().catch(err => {
    console.error('❌ ERROR GLOBAL:', err);
    process.exit(1);
});
