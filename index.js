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


async function startFaro() {
    console.log('--- FARO v4.0 INICIANDO ---');
    const port = process.env.PORT || 10000;

    // ==========================================
    // CARGA DE IDENTIDAD PERSISTENTE
    // ==========================================
    let privateKey;
    const faroKeyEnv = process.env.FARO_KEY;

    if (faroKeyEnv && faroKeyEnv.length > 10) {
        try {
            const keyBytes = fromString(faroKeyEnv, 'base64pad');
            privateKey = privateKeyFromProtobuf(keyBytes);
            console.log('✅ Identidad persistente cargada desde FARO_KEY.');
        } catch (e) {
            console.error('❌ Error cargando FARO_KEY:', e.message);
            console.warn('⚠️ Se generará una identidad nueva.');
        }
    } else {
        console.warn('⚠️ FARO_KEY no encontrada. Se generará una identidad nueva.');
    }

    // ==========================================
    // CREAR NODO
    // ==========================================
    const node = await createLibp2p({
        ...(privateKey ? { privateKey } : {}),
        nodeInfo: { name: 'whispernode-faro', version: '4.0.0' },
        addresses: {
            listen: [`/ip4/0.0.0.0/tcp/${port}/ws`],
            announce: [`/dns4/faro-whisper.onrender.com/tcp/443/wss`]
        },
        connectionManager: {
            maxConnections: 5000,
            minConnections: 10,
            maxIdleTime: 24 * 60 * 60 * 1000, // 24 horas — no cerrar conexiones inactivas
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

    await node.start();
    console.log(`\n🚀 FARO v4.0 ONLINE!`);
    console.log(`📍 PeerID: ${node.peerId.toString()}`);

    // ==========================================
    // EXPORTAR CLAVE SI ES NUEVA
    // ==========================================
    if (!privateKey) {
        try {
            // Accedemos a la clave privada generada internamente por libp2p
            const internalKey = node.components.privateKey;
            const exported = privateKeyToProtobuf(internalKey);
            const b64Key = toString(exported, 'base64pad');
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🔑 COPIA ESTA CLAVE Y PONLA EN RENDER COMO "FARO_KEY":`);
            console.log(b64Key);
            console.log(`${'='.repeat(60)}\n`);
        } catch (e) {
            console.error('No se pudo exportar la clave:', e.message);
        }
    }

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
