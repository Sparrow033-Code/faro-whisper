import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';

async function startFaro() {
    // Render.com asignará el puerto dinámicamente en process.env.PORT, si no, usa el 10000 local.
    const port = process.env.PORT || 10000;

    const node = await createLibp2p({
        addresses: {
            listen: [
                // tcp estándar para pruebas locales
                `/ip4/0.0.0.0/tcp/${port}`,
                // WebSockets para que las apps Web y Electron de detrás de firewalls puedan entrar
                `/ip4/0.0.0.0/tcp/${port}/ws`
            ]
        },
        transports: [
            tcp(),
            webSockets()
        ],
        connectionEncryption: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify(),
            // 1. Circuito Relay MUNDIAL ILIMITADO
            relay: circuitRelayServer({
                reservations: { applyDefaultLimit: false, maxReservations: Infinity }
            }),
            // 2. Kademlia en MODO SERVIDOR (Admite que tú guardes y leas "Dead-Drops" y busques IPs)
            dht: kadDHT({
                protocol: '/ipfs/kad/1.0.0',
                clientMode: false 
            })
        }
    });

    console.log('====================================================');
    console.log('🗼 FARO WHISPER-NODE INICIADO CON EXITO!');
    console.log('====================================================');
    console.log(`Bajo el ID: ${node.peerId.toString()}`);
    console.log('Direcciones de escucha:');
    node.getMultiaddrs().forEach((ma) => console.log(ma.toString()));
}

startFaro().catch(err => {
    console.error('El Faro se ha apagado o falló: ', err);
    process.exit(1);
});
