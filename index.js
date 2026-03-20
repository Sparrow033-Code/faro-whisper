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
    const port = process.env.PORT || 10000;

    console.log('🗼 Iniciando Faro (Modo Automático)...');
    
    let privateKey;
    if (process.env.FARO_KEY && process.env.FARO_KEY.length > 50) {
        try {
            privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
            console.log('✅ FARO_KEY cargada correctamente.');
        } catch (e) {
            console.error('❌ Error cargando FARO_KEY persistente:', e.message);
            console.warn('⚠️ La clave en Render es inválida. Usaremos una nueva.');
        }
    }

    const node = await createLibp2p({
        // Solo pasamos privateKey si se cargó bien. 
        // Si no, libp2p generará una nueva automáticamente sin errores de "bytes" ni "length".
        ...(privateKey ? { privateKey } : {}),
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
    console.log(`\n🚀 FARO ONLINE!`);
    console.log(`📍 PeerID: ${node.peerId.toString()}`);
    
    // Si no teníamos clave o la que había falló, mostramos la que el nodo ha generado internamente
    if (!privateKey) {
        try {
            const exported = privateKeyToProtobuf(node.components.privateKey);
            console.log(`\n🔑 NUEVA FARO_KEY PARA RENDER:\n${toString(exported, 'base64pad')}\n`);
        } catch (e) {
            console.error('No se pudo exportar la nueva clave:', e.message);
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
