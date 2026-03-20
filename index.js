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
    console.log('--- [ MENSAJE DE CONTROL: HOLA_SOY_EL_FARO_NUEVO ] ---');
    const port = process.env.PORT || 10000;
    
    let privateKey;
    const currentFaroKey = process.env.FARO_KEY;

    // Limpiamos la clave si es la de 148 bytes (formato viejo)
    if (currentFaroKey && currentFaroKey.length > 50) {
        try {
            const buf = fromString(currentFaroKey, 'base64pad');
            if (buf.length !== 148) {
                privateKey = privateKeyFromProtobuf(buf);
                console.log('✅ FARO_KEY válida cargada.');
            } else {
                console.warn('⚠️ Ignorando FARO_KEY antigua de 148 bytes.');
            }
        } catch (e) {
            console.error('⚠️ FARO_KEY no válida:', e.message);
        }
    }

    if (!privateKey) {
        console.warn('⚠️ Generando nueva identidad limpia...');
        privateKey = await generateKeyPair('Ed25519');
    }

    if (privateKey.publicKey && !privateKey.public) privateKey.public = privateKey.publicKey;

    const peerId = await createFromPrivKey(privateKey);
    console.log(`📍 PeerID: ${peerId.toString()}`);

    const node = await createLibp2p({
        peerId,
        nodeInfo: { name: 'faro', version: '4.0.0' }, // Cambiamos versión para forzar refresco
        addresses: {
            listen: [`/ip4/0.0.0.0/tcp/${port}/ws`],
            announce: [`/dns4/faro-whisper.onrender.com/tcp/443/wss`]
        },
        transports: [tcp(), webSockets({ filter: (addrs) => addrs })],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify({ agentVersion: 'faro/4.0.0', protocolVersion: 'ipfs/0.1.0' }),
            ping: ping(),
            relay: circuitRelayServer({ reservations: { applyDefaultLimit: false, maxReservations: 1000 } }),
            dht: kadDHT({ protocol: '/wsmp/kad/1.0.0', clientMode: false, validators: { wsmp: async () => true } })
        }
    });

    await node.start();
    console.log(`\n🚀 ¡FARO ONLINE Y ESTABLE!`);
    
    // Si la clave era nueva, la mostramos
    if (!currentFaroKey || fromString(currentFaroKey, 'base64pad').length === 148) {
        const exported = privateKeyToProtobuf(privateKey);
        console.log(`\n🔑 CÓDIGO PARA RENDER (FARO_KEY):\n${toString(exported, 'base64pad')}\n`);
    }

    node.addEventListener('peer:connect', (evt) => console.log(`[Connect] ${evt.detail.toString().slice(0, 10)}...`));
    process.on('SIGTERM', () => node.stop().then(() => process.exit(0)));
}

startFaro().catch(err => {
    console.error('❌ ERROR CRÍTICO:', err);
    process.exit(1);
});
