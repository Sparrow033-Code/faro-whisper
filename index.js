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
const MAX_DROP_SIZE = 65536; // 64KB
const DROP_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

// Map<boxId, Array<{payload, timestamp}>>
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

function handleDropProtocol(data) {
    const { stream } = data;

    // Leemos todo el mensaje del stream
    const chunks = [];
    const reader = async () => {
        try {
            for await (const chunk of stream.source) {
                chunks.push(chunk.subarray());
            }

            const message = toString(new Uint8Array(Buffer.concat(chunks)));
            const spaceIdx = message.indexOf(' ');
            if (spaceIdx === -1) {
                await sendResponse(stream, 'ERROR INVALID_COMMAND');
                return;
            }

            const command = message.substring(0, spaceIdx);
            const rest = message.substring(spaceIdx + 1);

            if (command === 'STORE') {
                // Formato: STORE <hexBoxId> <base64Payload>
                const parts = rest.split(' ', 2);
                if (parts.length < 2) {
                    await sendResponse(stream, 'ERROR INVALID_STORE');
                    return;
                }

                const [boxId, payload] = parts;

                // Verificar tamaño
                if (payload.length > MAX_DROP_SIZE) {
                    await sendResponse(stream, 'ERROR TOO_LARGE');
                    return;
                }

                // Almacenar
                if (!dropBoxes.has(boxId)) {
                    dropBoxes.set(boxId, []);
                }
                const box = dropBoxes.get(boxId);

                if (box.length >= MAX_DROPS_PER_BOX) {
                    // Descartamos el más viejo
                    box.shift();
                }

                box.push({ payload, timestamp: Date.now() });
                console.log(`[Buzón] 📥 Drop almacenado en buzón ${boxId.substring(0, 8)}... (${box.length} total)`);
                await sendResponse(stream, 'OK STORED');

            } else if (command === 'FETCH') {
                // Formato: FETCH <hexBoxId>
                const boxId = rest.trim();
                const box = dropBoxes.get(boxId);

                if (!box || box.length === 0) {
                    await sendResponse(stream, 'OK EMPTY');
                    return;
                }

                // Entregamos el primer drop (FIFO) y lo borramos
                const drop = box.shift();
                if (box.length === 0) {
                    dropBoxes.delete(boxId);
                }

                console.log(`[Buzón] 📤 Drop entregado desde buzón ${boxId.substring(0, 8)}...`);
                await sendResponse(stream, `OK DATA ${drop.payload}`);

            } else {
                await sendResponse(stream, 'ERROR UNKNOWN_COMMAND');
            }
        } catch (e) {
            // Stream cerrado o error de red — ignorar silenciosamente
        }
    };

    reader();
}

async function sendResponse(stream, message) {
    try {
        const encoded = fromString(message);
        await stream.sink([encoded]);
    } catch (e) {
        // Sink ya cerrado
    }
}


// ==========================================
// ARRANQUE DEL FARO
// ==========================================
async function startFaro() {
    console.log('--- FARO v4.1 (Buzón Ciego) INICIANDO ---');
    const port = process.env.PORT || 10000;

    // Carga de identidad persistente
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
        nodeInfo: { name: 'whispernode-faro', version: '4.1.0' },
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

    // Registrar protocolo de buzón ciego
    await node.handle('/wsmp/drop/1.0.0', handleDropProtocol);

    await node.start();
    console.log(`\n🚀 FARO v4.1 ONLINE (con Buzón Ciego)`);
    console.log(`📍 PeerID: ${node.peerId.toString()}`);
    console.log(`📬 Protocolo de buzón: /wsmp/drop/1.0.0`);

    // Exportar clave si es nueva
    if (!privateKey) {
        try {
            const exported = privateKeyToProtobuf(node.components.privateKey);
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🔑 NUEVA FARO_KEY PARA RENDER:`);
            console.log(toString(exported, 'base64pad'));
            console.log(`${'='.repeat(60)}\n`);
        } catch (e) {}
    }

    // Limpieza de drops expirados cada hora
    setInterval(cleanExpiredDrops, 60 * 60 * 1000);

    node.addEventListener('peer:connect', (evt) => {
        console.log(`[Connect] 🤝 ${evt.detail.toString().slice(0, 16)}...`);
    });

    const stop = async () => {
        await node.stop();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

startFaro().catch(err => {
    console.error('❌ ERROR FATAL:', err);
    process.exit(1);
});
