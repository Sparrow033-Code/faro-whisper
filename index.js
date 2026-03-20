import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { createFromPrivKey } from '@libp2p/peer-id-factory';
import { fromString } from 'uint8arrays/from-string';
import { toString } from 'uint8arrays/to-string';

async function startFaro() {
    const port = process.env.PORT || 10000;
    console.log('🗼 Iniciando Faro (Fase de Estabilización V2)...');
    
    let privateKey;
    const currentFaroKey = process.env.FARO_KEY;

    // Si la clave existe, intentamos cargarla, pero con cuidado extremo
    if (currentFaroKey && currentFaroKey.length > 50) {
        try {
            const buf = fromString(currentFaroKey, 'base64pad');
            // Si mide 148 bytes binarios, sabemos por experiencia que está corrupta
            if (buf.length === 148) {
                throw new Error("Clave de 148 bytes detectada como CORRUPTA (procede de un formato incompatible).");
            }
            privateKey = privateKeyFromProtobuf(buf);
            console.log('✅ FARO_KEY cargada en memoria.');
        } catch (e) {
            console.error('⚠️ Ignorando FARO_KEY de Render:', e.message);
        }
    }

    if (!privateKey) {
        console.warn('⚠️ Generando nueva identidad limpia...');
        privateKey = await generateKeyPair('Ed25519');
    }

    // Parche de compatibilidad obligatorio
    if (privateKey.publicKey && !privateKey.public) privateKey.public = privateKey.publicKey;

    // Crear el PeerId de forma segura ANTES de inicializar libp2p
    const peerId = await createFromPrivKey(privateKey);
    console.log(`📍 PeerID Final: ${peerId.toString()}`);

    const node = await createLibp2p({
        peerId,
        nodeInfo: { name: 'whispernode-faro', version: '3.2.6' },
        addresses: {
            listen: [`/ip4/0.0.0.0/tcp/${port}/ws`],
            announce: [`/dns4/faro-whisper.onrender.com/tcp/443/wss`]
        },
        transports: [tcp(), webSockets({ filter: (addrs) => addrs })],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify({
                agentVersion: 'whispernode-faro/3.2.6',
                protocolVersion: 'ipfs/0.1.0'
            }),
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
    console.log(`\n🚀 FARO DESPLEGADO CON ÉXITO!`);
    
    // Si la clave de Render era mala o no existía, mostramos la nueva
    if (!currentFaroKey || fromString(currentFaroKey, 'base64pad').length === 148) {
        const exported = privateKeyToProtobuf(privateKey);
        console.log(`\n🔑 COPIA ESTO Y PONLO EN RENDER (FARO_KEY):\n${toString(exported, 'base64pad')}\n`);
    }

    node.addEventListener('peer:connect', (evt) => {
        console.log(`[Connect] 🤝 ${evt.detail.toString().slice(0, 16)}...`);
    });

    const stop = async () => {
        await node.stop();
        process.exit(0);
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

startFaro().catch(err => {
    console.error('❌ ERROR FATAL:', err);
    process.exit(1);
});
