import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { ping } from '@libp2p/ping';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { toString } from 'uint8arrays/to-string';


async function startFaro() {
    const port = process.env.PORT || 10000;

    console.log('🗼 MODO DIAGNÓSTICO: Ignorando FARO_KEY para forzar arranque limpio...');
    
    const node = await createLibp2p({
        addresses: {
            listen: [`/ip4/0.0.0.0/tcp/${port}/ws`],
            announce: [`/dns4/faro-whisper.onrender.com/tcp/443/wss`]
        },
        transports: [
            tcp(),
            webSockets({ filter: (addrs) => addrs })
        ],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            // Deshabilitamos Identify temporalmente para evitar el choque de Identify.start
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
    console.log(`\n🚀 FARO DE EMERGENCIA ONLINE!`);
    console.log(`📍 PeerID: ${node.peerId.toString()}`);
    
    const { privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const exported = privateKeyToProtobuf(node.components.privateKey);
    console.log(`\n🔑 NUEVA FARO_KEY (Copia esto y ponlo en Render):\n${toString(exported, 'base64pad')}\n`);

    node.addEventListener('peer:connect', (evt) => {
        console.log(`[Connect] 🤝 ${evt.detail.toString().slice(0, 16)}...`);
    });

    const stop = async () => {
        console.log('\n🛑 Apagando...');
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
