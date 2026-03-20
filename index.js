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

    console.log('🗼 Iniciando Faro con IDENTIDAD PERSISTENTE...');
    
    let privateKey;
    if (process.env.FARO_KEY) {
        try {
            privateKey = privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
            console.log('✅ Clave FARO_KEY cargada.');
        } catch (e) {
            console.error('❌ Error cargando FARO_KEY:', e.message);
        }
    }

    if (!privateKey) {
        console.warn('⚠️ Generando nueva identidad temporal...');
        privateKey = await generateKeyPair('Ed25519');
        // PARCHE DE COMPATIBILIDAD: Algunas versiones antiguas esperan .public y las nuevas .publicKey
        if (privateKey.publicKey && !privateKey.public) {
            privateKey.public = privateKey.publicKey;
        }
        
        const exported = privateKeyToProtobuf(privateKey);
        console.log(`\n🔑 NUEVA FARO_KEY (Guárdala en Render):\n${toString(exported, 'base64pad')}\n`);
    }

    // Parche por si se cargó de FARO_KEY pero no tiene la propiedad correcta
    if (privateKey.publicKey && !privateKey.public) {
        privateKey.public = privateKey.publicKey;
    }

    // En libp2p 1.x es mejor pasar el PeerId ya creado desde la clave
    const peerId = await createFromPrivKey(privateKey);
    console.log(`📍 PeerID: ${peerId.toString()}`);

    const node = await createLibp2p({
        peerId, // Identidad completa
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
    console.log(`\n🚀 FARO DESPLEGADO CON ÉXITO!`);
    
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
