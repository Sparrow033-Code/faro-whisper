import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { toString } from 'uint8arrays/to-string';


async function startFaro() {
    const port = process.env.PORT || 10000;

    console.log('🗼 Iniciando Faro con IDENTIDAD NUEVA (Segura)...');
    
    // Generamos la clave ANTES de arrancar para poder loguearla incluso si el arranque falla
    const privateKey = await generateKeyPair('Ed25519');
    const exportedBinary = privateKeyToProtobuf(privateKey);
    const faroKeyBase64 = toString(exportedBinary, 'base64pad');

    console.log(`\n🔑 NUEVA FARO_KEY (Guárdala en Render como FARO_KEY):\n${faroKeyBase64}\n`);
    
    const node = await createLibp2p({
        privateKey, // Pasamos la clave generada
        nodeInfo: {
            name: 'whispernode-faro',
            version: '3.2.4'
        },
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
            // El DHT REQUIERE el servicio Identify obligatoriamente
            identify: identify({
                agentVersion: 'whispernode-faro/3.2.4',
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
    console.log(`📍 PeerID: ${node.peerId.toString()}`);
    
    node.addEventListener('peer:connect', (evt) => {
        console.log(`[Connect] 🤝 Nuevo usuario vinculado: ${evt.detail.toString().slice(0, 16)}...`);
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
    console.error('❌ ERROR FATAL EN ARRANQUE:', err);
    process.exit(1);
});
