/**
 * YOOSEE CAMERA INTERCOM CLIENT
 * Usage: node intercom.js --ip <IP1,IP2...> [options]
 */

const net = require('net');
const spawn = require('child_process').spawn;
const path = require('path');

// --- COMMAND LINE ARGUMENT PARSING FUNCTION ---
function parseArgs() {
    const args = process.argv.slice(2);
    const params = {
        ips: [],
        port: 554,
        file: 'music.mp3', // Default
        rate: 8000,        // Default 8000Hz
        volume: 0.5,       // Default 50%
        debug: false       // Default off
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--ip':
                // Support comma-separated IPs or multiple --ip flags
                const ipInput = args[i + 1];
                if (ipInput) {
                    const extractedIps = ipInput.split(',').map(ip => ip.trim()).filter(ip => ip);
                    params.ips.push(...extractedIps);
                }
                i++;
                break;
            case '--port':
                params.port = parseInt(args[i + 1]);
                i++;
                break;
            case '--file':
                params.file = args[i + 1];
                i++;
                break;
            case '--rate':
                params.rate = parseInt(args[i + 1]);
                i++;
                break;
            case '--vol':
                params.volume = parseFloat(args[i + 1]);
                i++;
                break;
            case '--debug':
                params.debug = true;
                break;
            case '--help':
                showHelp();
                process.exit(0);
        }
    }

    if (params.ips.length === 0) {
        console.error('Error: Missing required argument --ip');
        showHelp();
        process.exit(1);
    }

    // Deduplicate IPs
    params.ips = [...new Set(params.ips)];

    return params;
}

function showHelp() {
    console.log(`
Usage:
  node intercom.js --ip <IP_ADDRESS> [options]

  You can broadcast to multiple cameras by separating IPs with commas:
  node intercom.js --ip 192.168.1.10,192.168.1.11

Optional parameters:
  --port <number>   RTSP Port (Default: 554)
  --file <path>     Audio file path (Default: music.mp3)
  --rate <number>   Sample rate (Default: 8000). Try 16000 if audio is slow.
  --vol  <number>   Volume from 0.1 to 2.0 (Default: 0.5)

Example:
  node intercom.js --ip 192.168.1.100,192.168.1.101 --file notification.wav
    `);
}

// --- CONFIG FROM ARGUMENTS ---
const config = parseArgs();

console.log('------------------------------------------');
console.log(`Target IPs:  ${config.ips.join(', ')}`);
console.log(`Port:        ${config.port}`);
console.log(`Audio File:  ${config.file}`);
console.log(`Sample Rate: ${config.rate} Hz`);
console.log(`Volume:      ${config.volume}`);
console.log(`Debug Mode:  ${config.debug ? 'ON' : 'OFF'}`);
console.log('------------------------------------------');

// Fixed technical configuration
const CHUNK_SIZE = 320;
const FRAME_LEN = 332;
const MAX_BUFFER_AHEAD_MS = 2000;
const SPEED_MULTIPLIER = 1

// --- CAMERA CLIENT CLASS ---
class CameraClient {
    constructor(ip, port, sampleRate) {
        this.ip = ip;
        this.port = port;
        this.sampleRate = sampleRate;

        this.socket = new net.Socket();
        this.audioQueue = [];
        this.startTime = 0;
        this.totalBytesSent = 0;
        this.isThrottling = false;
        this.isConnected = false;

        this.setupSocket();
    }

    logDebug(msg) {
        if (config.debug) {
            console.log(`[DEBUG][${this.ip}] ${msg}`);
        }
    }

    setupSocket() {
        this.socket.setTimeout(10000); // 10 seconds timeout for initial connection

        this.socket.on('timeout', () => {
            console.log(`[${this.ip}] Connection timed out. Destroying.`);
            this.socket.destroy();
            this.isConnected = false;
            this.audioQueue = []; // Free memory
        });

        this.socket.on('data', (data) => {
            console.log(`[${this.ip}] RX: ${data.toString()}`);
            if (config.debug) {
                this.logDebug(`RX Data: ${data.toString().trim().replace(/\r\n/g, '\\n')}`);
            }

            if (data.toString().includes('CSeq: 8')) {
                console.log(`[${this.ip}] >>> Camera accepted. Ready to stream.`);
                this.isConnected = true;
                this.socket.setTimeout(0); // Disable timeout while streaming
                // Try to process queue immediately if we have data waiting
                if (this.audioQueue.length > 0) this.processQueue();
            }
        });

        this.socket.on('error', (err) => {
            console.error(`[${this.ip}] !!! Connection error: ${err.message}`);
            this.isConnected = false;
        });

        this.socket.on('close', () => {
            console.log(`[${this.ip}] Connection closed.`);
            this.isConnected = false;
        });
    }

    connect() {
        console.log(`[${this.ip}] Connecting...`);
        this.socket.connect(this.port, this.ip, () => {
            this.socket.setNoDelay(true);
            console.log(`[${this.ip}] >>> Sending OPEN command...`);
            this.logDebug(`Connected to ${this.ip}:${this.port}. Sending OPEN command.`);

            const openCmd = `USER_CMD_SET rtsp://${this.ip}/onvif1 RTSP/1.0\r\n` +
                `CSeq: 8\r\n` +
                `Content-length: strlen(Content-type)\r\n` +
                `Content-type: AudioCtlCmd:OPEN\r\n\r\n`;
            this.socket.write(openCmd);
            this.logDebug(`Sent OPEN command`);
        });
    }

    enqueue(chunk) {
        // Buffer data even if not yet connected, so we don't miss the start of the file
        // while the RTSP handshake is happening.
        this.audioQueue.push(Buffer.from(chunk));

        this.logDebug(`Enqueued chunk. Queue size: ${this.audioQueue.length}`);

        // Prevent memory leak if camera is not connecting/slow
        // 50000 chunks * 320 bytes = 16MB ~ 50 minutes of audio
        if (!this.isConnected && this.audioQueue.length > 50000) {
            this.audioQueue.shift(); // Remove oldest packet
            this.logDebug(`Queue full (not connected). Dropped oldest packet.`);
        }

        if (this.isConnected && !this.isThrottling) {
            this.processQueue();
        }
    }

    processQueue() {
        // If not connected yet, keeps packets in queue.
        // If socket is destroyed, we can clear.
        if (this.socket.destroyed) {
            this.audioQueue = [];
            return;
        }

        if (!this.isConnected) {
            return;
        }

        this.isThrottling = true;

        if (this.audioQueue.length === 0) {
            this.isThrottling = false;
            return;
        }

        if (this.startTime === 0) {
            // BURST Logic
            const burstPackets = Math.floor(this.sampleRate * 2 / CHUNK_SIZE);

            if (this.audioQueue.length > burstPackets) {
                console.log(`[${this.ip}] >>> Bursting ${burstPackets} packets...`);
                for (let i = 0; i < burstPackets; i++) {
                    this.sendRtspFrame(this.audioQueue.shift());
                }
                this.startTime = Date.now();
            } else {
                // Wait for more data
                this.isThrottling = false;
                this.logDebug(`Buffering... Current: ${this.audioQueue.length}, Need: ${burstPackets}`);
                return;
            }
        }

        const timeElapsed = Date.now() - this.startTime;
        const bytesPerSecond = this.sampleRate * 2;
        const audioTimeSentAdjusted = ((this.totalBytesSent / bytesPerSecond) * 1000) / SPEED_MULTIPLIER;

        if (audioTimeSentAdjusted > timeElapsed + MAX_BUFFER_AHEAD_MS) {
            // Buffer is full, wait a bit
            // this.logDebug(`Throttling... Ahead: ${(audioTimeSentAdjusted - timeElapsed).toFixed(2)}ms`); 
            setTimeout(() => this.processQueue(), 10);
            return;
        }

        const chunk = this.audioQueue.shift();
        if (chunk) {
            this.sendRtspFrame(chunk);
        }

        // Continue processing next loop
        setImmediate(() => this.processQueue());
    }

    sendRtspFrame(chunk) {
        if (this.socket.destroyed) return;

        const header = Buffer.alloc(4);
        header[0] = 0x24; // $
        header[1] = 0x02; // Channel 2
        header.writeUInt16LE(FRAME_LEN, 2);

        const padding = Buffer.alloc(12, 0);
        try {
            this.socket.write(Buffer.concat([header, padding, chunk]));
            this.totalBytesSent += chunk.length;
        } catch (e) {
            console.error(`[${this.ip}] Write error:`, e.message);
        }
    }

    stop() {
        console.log(`[${this.ip}] >>> Disconnecting...`);
        const closeCmd = `USER_CMD_SET rtsp://${this.ip}/onvif1 RTSP/1.0\r\n` +
            `CSeq: 10\r\n` +
            `Content-length: strlen(Content-type)\r\n` +
            `Content-type: AudioCtlCmd:CLOSE\r\n\r\n`;

        if (this.socket.writable) {
            try {
                this.socket.write(closeCmd);
            } catch (e) { /* ignore */ }
        }

        setTimeout(() => {
            this.socket.destroy();
        }, 50);
    }
}

// --- INITIALIZE CLIENTS ---
const clients = config.ips.map(ip => new CameraClient(ip, config.port, config.rate));

// Connect all clients
clients.forEach(client => client.connect());

// Start centralized FFmpeg
startCentralizedStreaming();

function startCentralizedStreaming() {
    console.log(`>>> Starting FFmpeg transcoding for ${clients.length} clients...`);

    const ffmpeg = spawn('ffmpeg', [
        '-i', config.file,
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        '-ar', config.rate.toString(),
        '-ac', '1',
        '-filter:a', `volume=${config.volume}`,
        'pipe:1'
    ]);

    ffmpeg.stdout.on('data', (chunk) => {
        // Fan-out chunks to all connected clients
        for (let i = 0; i < chunk.length; i += CHUNK_SIZE) {
            const subChunk = chunk.slice(i, i + CHUNK_SIZE);
            if (subChunk.length === CHUNK_SIZE) {
                clients.forEach(client => client.enqueue(subChunk));
            }
        }
    });

    ffmpeg.on('close', () => console.log('>>> Finished reading audio file.'));

    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('No such file') || msg.includes('Error')) {
            console.error(`FFmpeg Error: ${msg}`);
        }
    });
}

// Handle stop
process.on('SIGINT', () => {
    console.log('\n>>> Stopping all streams...');
    clients.forEach(client => client.stop());
    setTimeout(() => {
        process.exit();
    }, 100);
});