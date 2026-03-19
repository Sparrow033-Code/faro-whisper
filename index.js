// index.js (ACTUALIZADO: Imports sincronizados)
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise'; // <-- Cambiado de @chainsafe
import { yamux } from '@libp2p/yamux'; // <-- Cambiado de @chainsafe
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { fromString } from 'uint8arrays/from-string';

async function startFaro() {
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        console.log('🗼 Cargando clave persistente de FARO_KEY...');
        privateKey = await privateKeyFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
    }

    const node = await createLibp2p({
        privateKey,
        addresses: {
            listen: [
                `/ip4/0.0.0.0/tcp/${port}/ws`
            ]
        },
        transports: [tcp(), webSockets()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify(),
            ping: ping(),
            relay: circuitRelayServer({
                reservations: { applyDefaultLimit: false, maxReservations: Infinity }
            }),
            dht: kadDHT({
                protocol: '/ipfs/kad/1.0.0',
                clientMode: false 
            })
        }
    });

    console.log('====================================================');
    console.log('🗼 FARO WHISPER-NODE INICIADO CON EXITO (v3.1.5)!');
    console.log('====================================================');
    console.log(`Bajo el ID: ${node.peerId.toString()}`);
    console.log('Direcciones de escucha:');
    node.getMultiaddrs().forEach((ma) => console.log(ma.toString()));
}

startFaro().catch(err => {
    console.error('El Faro se ha apagado o falló: ', err);
    process.exit(1);
});
