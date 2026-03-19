import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import * as http from 'http';

async function startFaro() {
    const port = process.env.PORT || 10000;

    // 1. FACHADA WEB: Para contentar a los robots inspectores de Render
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WhisperNode Faro IPFS Kademlia Node is ALIVE and RUNNING!\n');
    });

    // 2. MOTOR P2P: Montado por la puerta trasera "server" de WebSocket
    const node = await createLibp2p({
        addresses: {
            // Quitamos el puerto TCP crudo ya que Render expone 1 solo puerto Web público
            listen: [`/ip4/0.0.0.0/tcp/${port}/ws`]
        },
        transports: [
            webSockets({ server }) // Enganchamos el P2P Cifrado encima del Servidor Web
        ],
        connectionEncryption: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify(),
            relay: circuitRelayServer({
                reservations: { applyDefaultLimit: false, maxReservations: Infinity }
            }),
            dht: kadDHT({
                protocol: '/ipfs/kad/1.0.0',
                clientMode: false 
            })
        }
    });


