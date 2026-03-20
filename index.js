import http from 'http';
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

/**
 * PROTOCOLO STORE (P2P): Cliente envía, Faro almacena. Fire-and-forget (sin respuesta).
 * Formato del mensaje: <hexBoxId> <base64Payload>
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

            if (!dropBoxes.has(boxId)) {
                dropBoxes.set(boxId, []);
            }
            const box = dropBoxes.get(boxId);

            if (box.length >= MAX_DROPS_PER_BOX) {
                box.shift();
            }

            box.push({ payload, timestamp: Date.now() });
            console.log(`[Buzón] 📥 Drop almacenado en buzón ${boxId.substring(0, 8)}... (${box.length} total)`);
        } catch (e) {
            // Stream cerrado — normal
        }
    };
    reader();
}


// ==========================================
// HTTP SERVER PARA FETCH (evita streams bidireccionales)
// ==========================================
function createHttpServer() {
    return http.createServer((req, res) => {
        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET');

        // GET /fetch/<boxId> → entrega primer drop del buzón
        if (req.method === 'GET' && req.url && req.url.startsWith('/fetch/')) {
            const boxId = decodeURIComponent(req.url.substring(7)); // después de '/fetch/'
            
            if (!boxId || boxId.length < 8) {
                res.writeHead(400);
                res.end('BAD_REQUEST');
                return;
            }

            const box = dropBoxes.get(boxId);

            if (!box || box.length === 0) {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('EMPTY');
                return;
            }

            // Entregar primer drop (FIFO) y borrarlo
            const drop = box.shift();
            if (box.length === 0) {
                dropBoxes.delete(boxId);
            }

            console.log(`[Buzón] 📤 Drop entregado (HTTP) desde buzón ${boxId.substring(0, 8)}...`);
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(drop.payload);
            return;
        }

        // GET /status → diagnóstico rápido
        if (req.method === 'GET' && req.url === '/status') {
            let totalDrops = 0;
            for (const box of dropBoxes.values()) totalDrops += box.length;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: 'ok', 
                version: '4.3', 
                buzones: dropBoxes.size, 
                drops: totalDrops 
            }));
            return;
        }

        // Cualquier otra cosa → OK simple (para health checks de Render)
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('FARO v4.3');
    });
}


// ==========================================
// ARRANQUE DEL FARO
// ==========================================
async function startFaro() {
    console.log('--- FARO v4.3 (HTTP Fetch + P2P Store) INICIANDO ---');
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

    // 1. Crear HTTP server con endpoint de FETCH
    const httpServer = createHttpServer();

    // 2. Arrancar HTTP server
    await new Promise((resolve) => {
        httpServer.listen(port, '0.0.0.0', resolve);
    });
    console.log(`📡 HTTP Server escuchando en puerto ${port}`);

    // 3. Crear nodo libp2p usando el HTTP server existente para WebSockets
    const node = await createLibp2p({
        ...(privateKey ? { privateKey } : {}),
        nodeInfo: { name: 'whispernode-faro', version: '4.3.0' },
        addresses: {
            announce: [`/dns4/faro-whisper.onrender.com/tcp/443/wss`]
        },
        connectionManager: {
            maxConnections: 5000,
            minConnections: 10,
            maxIdleTime: 24 * 60 * 60 * 1000,
        },
        transports: [
            tcp(),
            webSockets({ 
                websocket: { server: httpServer },
                filter: (addrs) => addrs 
            })
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

    // Registrar protocolo P2P para STORE (fire-and-forget, funciona perfecto)
    await node.handle('/wsmp/drop/store/1.0.0', handleDropStore);

    await node.start();
    console.log(`\n🚀 FARO v4.3 ONLINE`);
    console.log(`📍 PeerID: ${node.peerId.toString()}`);
    console.log(`📬 STORE: /wsmp/drop/store/1.0.0 (P2P)`);
    console.log(`📬 FETCH: GET /fetch/<boxId> (HTTP)`);

    // Exportar clave si es nueva
    if (!privateKey) {
        try {
            const exported = privateKeyToProtobuf(node.components.privateKey);
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🔑 NUEVA FARO_KEY PARA RENDER:`);
            console.log(toString(exported, 'base64pad'));
            console.log(`${'='.repeat(60)}\n`);
        } catch (e) { }
    }

    // Limpieza de drops expirados cada hora
    setInterval(cleanExpiredDrops, 60 * 60 * 1000);

    node.addEventListener('peer:connect', (evt) => {
        console.log(`[Connect] 🤝 ${evt.detail.toString().slice(0, 16)}...`);
    });

    const stop = async () => {
        await node.stop();
        httpServer.close();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

startFaro().catch(err => {
    console.error('❌ ERROR FATAL:', err);
    process.exit(1);
});
