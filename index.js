import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { unmarshalPrivateKey } from '@libp2p/crypto/keys';
import { fromString } from 'uint8arrays/from-string';


async function startFaro() {
    const port = process.env.PORT || 10000;

    let privateKey;
    if (process.env.FARO_KEY) {
        console.log('🗼 Cargando clave persistente de FARO_KEY...');
        try {
            const keyBuffer = fromString(process.env.FARO_KEY, 'base64pad');
            privateKey = await unmarshalPrivateKey(keyBuffer);
            console.log('✅ Clave privada cargada correctamente.');
        } catch (e) {
            console.error('❌ Error crítico cargando FARO_KEY. Se generará un ID aleatorio:', e.message);
        }
    } else {
        console.warn('⚠️ No se encontró FARO_KEY en las variables de entorno. Usando ID aleatorio temporal.');
    }

    const node = await createLibp2p({
        // Forzamos la identidad cargada usando la clave privada desempaquetada
        privateKey: privateKey,
        addresses: {
            listen: [
                `/ip4/0.0.0.0/tcp/${port}/ws`
            ],
            announce: [
                // Render.com mapea HTTPS/WSS (443) a nuestro puerto interno (WS)
                `/dns4/faro-whisper.onrender.com/tcp/443/wss`
            ]
        },
        connectionManager: {
            maxConnections: 5000,
            minConnections: 10,
            maxIdleTime: 24 * 60 * 60 * 1000, // 24 horas de gracia para conexiones inactivas
        },
        transports: [
            tcp(),
            webSockets({
                filter: (addrs) => addrs // Aceptar cualquier dirección (incluyendo WSS)
            })
        ],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify(),
            ping: ping(),
            relay: circuitRelayServer({
                reservations: {
                    applyDefaultLimit: false,
                    maxReservations: 1000 // Aumentado para soportar muchos clientes
                }
            }),
            dht: kadDHT({
                protocol: '/wsmp/kad/1.0.0',
                clientMode: false, // El Faro debe actuar como SERVIDOR en la DHT
                validators: {
                    wsmp: async (key, value) => {
                        // Validador permissivo para WSMP
                        return true;
                    }
                }
            })
        }
    });

    await node.start();
    console.log(`\n🚀 Faro WhisperNode v3.2.1 desplegado con éxito!`);
    console.log(`🔗 Rendimiento: 1000 reservas de relay permitidas.`);
    console.log(`📍 Dirección de anuncio: /dns4/faro-whisper.onrender.com/tcp/443/wss/p2p/${node.peerId.toString()}`);

    // Logs de monitorización para Render
    node.addEventListener('peer:connect', (evt) => {
        console.log(`[Connect] 🤝 Nuevo usuario vinculado: ${evt.detail.toString().slice(0, 16)}...`);
    });

    node.addEventListener('peer:disconnect', (evt) => {
        console.log(`[Disconnect] 👋 Usuario desconectado: ${evt.detail.toString().slice(0, 16)}...`);
    });

    console.log('Direcciones de escucha:');
    node.getMultiaddrs().forEach((ma) => console.log(`  ${ma.toString()}`));
    
    // Manejo de cierre gracioso
    const stop = async () => {
        console.log('\n🛑 Apagando el Faro...');
        await node.stop();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}


startFaro().catch(err => {
    console.error('El Faro se ha apagado o falló: ', err);
    process.exit(1);
});
