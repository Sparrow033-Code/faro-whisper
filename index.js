import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { createFromProtobuf } from '@libp2p/peer-id-factory';
import { fromString } from 'uint8arrays/from-string';

async function startFaro() {
    const port = process.env.PORT || 10000;

    let peerId;
    if (process.env.FARO_KEY) {
        console.log('🗼 Cargando clave persistente de FARO_KEY...');
        try {
            peerId = await createFromProtobuf(fromString(process.env.FARO_KEY, 'base64pad'));
        } catch (e) {
            console.error('❌ Error cargando FARO_KEY:', e.message);
        }
    }

    const node = await createLibp2p({
        peerId,
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
                protocol: '/wsmp/kad/1.0.0',
                clientMode: false,
                validators: {
                    wsmp: async (key, value) => {}
                }
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
