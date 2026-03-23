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
// BUZÓN CIEGO (Dead Drop Store)
// ==========================================
const MAX_DROPS_PER_BOX = 100;
const MAX_DROP_SIZE = 65536;
const DROP_TTL_MS = 24 * 60 * 60 * 1000;

const dropBoxes = new Map();

function cleanExpiredDrops() {
    const now = Date.now();
    let cleaned = 0;
    for (const [boxId, drops] of dropBoxes.entries()) {
        const valid = drops.filter(d => (now - d.timestamp) < DROP_TTL_MS);
        if (valid.length === 0) {
            dropBoxes.delete(boxId);
            cleaned++;
        } else if (valid.length < drops.length) {
            dropBoxes.set(boxId, valid);
            cleaned += drops.length - valid.length;
        }
    }
    if (cleaned > 0) {
        console.log(`[Buzón] 🧹 Limpiados ${cleaned} drops expirados. Buzones activos: ${dropBoxes.size}`);
    }
}

/**
 * STORE (P2P fire-and-forget): Cliente envía, Faro almacena.
 */
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
            if (payload.length > MAX_DROP_SIZE) return;

            if (!dropBoxes.has(boxId)) dropBoxes.set(boxId, []);
            const box = dropBoxes.get(boxId);
            if (box.length >= MAX_DROPS_PER_BOX) box.shift();

            box.push({ payload, timestamp: Date.now() });
            console.log(`[Buzón] 📥 Drop almacenado en buzón ${boxId.substring(0, 8)}... (${box.length} total)`);
        } catch (e) { /* stream cerrado */ }
    };
    reader();
}

/**
 * FETCH (P2P): Cliente envía boxId, Faro responde con el drop.
 * El stream es half-duplex: primero lee, luego escribe.
 */
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
                try { await stream.sink([fromString('EMPTY')]); } catch(e){}
                return;
            }

            const box = dropBoxes.get(boxId);
            if (!box || box.length === 0) {
                console.log(`[Buzón] 🔍 FETCH buzón ${boxId.substring(0, 8)}... → vacío`);
                try { await stream.sink([fromString('EMPTY')]); } catch(e){}
                return;
            }

            const drop = box.shift();
            if (box.length === 0) dropBoxes.delete(boxId);

            console.log(`[Buzón] 📤 Drop entregado desde buzón ${boxId.substring(0, 8)}...`);
            try { await stream.sink([fromString(drop.payload)]); } catch(e){}
        } catch (e) {
            console.warn(`[Buzón] Error en FETCH:`, e.message);
        }
    };
    reader();
}


// ==========================================
// ARRANQUE DEL FARO (idéntico a v4.2 que funcionaba)
// ==========================================
async function startFaro() {
    console.log('--- FARO v4.4 INICIANDO ---');
    const port = process.env.PORT || 10000;

    let privateKey;
    const faroKeyEnv = process.env.FARO_KEY;
    if (faroKeyEnv && faroKeyEnv.length > 10) {
        try {
            const keyBytes = fromString(faroKeyEnv, 'base64pad');
            privateKey = privateKeyFromProtobuf(keyBytes);
            console.log('✅ Identidad persistente cargada desde FARO_KEY.');
        } catch (e) {
            console.error('❌ Error cargando FARO_KEY:', e.message);
        }
    }

    const node = await createLibp2p({
        ...(privateKey ? { privateKey } : {}),
        nodeInfo: { name: 'whispernode-faro', version: '4.4.0' },
        addresses: {
            listen: [`/ip4/0.0.0.0/tcp/${port}/ws`],
            announce: [`/dns4/faro-whisper.onrender.com/tcp/443/wss`]
        },
        connectionManager: {
            maxConnections: 5000,
            minConnections: 10,
            maxIdleTime: 24 * 60 * 60 * 1000,
        },
        transports: [
            tcp(),
            webSockets({ filter: (addrs) => addrs })
        ],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify(),
            ping: ping(),
            relay: circuitRelayServer({
                reservations: { applyDefaultLimit: false, maxReservations: 1000 }
            }),
            dht: kadDHT({
                protocol: '/wsmp/kad/1.0.0',
                clientMode: false,
                validators: { wsmp: async () => true }
            })
        }
    });

    await node.handle('/wsmp/drop/store/1.0.0', handleDropStore);
    await node.handle('/wsmp/drop/fetch/1.0.0', handleDropFetch);

    await node.start();
    console.log(`\n🚀 FARO v4.4 ONLINE`);
    console.log(`📍 PeerID: ${node.peerId.toString()}`);
    console.log(`📬 Protocolos: /wsmp/drop/store/1.0.0, /wsmp/drop/fetch/1.0.0`);

    if (!privateKey) {
        try {
            const exported = privateKeyToProtobuf(node.components.privateKey);
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🔑 NUEVA FARO_KEY:`);
            console.log(toString(exported, 'base64pad'));
            console.log(`${'='.repeat(60)}\n`);
        } catch (e) { }
    }

    setInterval(cleanExpiredDrops, 60 * 60 * 1000);

    node.addEventListener('peer:connect', (evt) => {
        console.log(`[Connect] 🤝 ${evt.detail.toString().slice(0, 16)}...`);
    });

    const stop = async () => { await node.stop(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

startFaro().catch(err => {
    console.error('❌ ERROR FATAL:', err);
    process.exit(1);
});
