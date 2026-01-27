/**
 * YOOSEE CAMERA INTERCOM CLIENT
 * Usage: node intercom.js --ip <IP> [options]
 */

const net = require('net');
const spawn = require('child_process').spawn;
const path = require('path');

// --- COMMAND LINE ARGUMENT PARSING FUNCTION ---
function parseArgs() {
    const args = process.argv.slice(2);
    const params = {
        ip: null,
        port: 554,
        file: 'music.mp3', // Default
        rate: 8000,        // Default 8000Hz
        volume: 0.5        // Default 50%
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--ip':
                params.ip = args[i + 1];
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
            case '--help':
                showHelp();
                process.exit(0);
        }
    }

    if (!params.ip) {
        console.error('Error: Missing required argument --ip');
        showHelp();
        process.exit(1);
    }

    return params;
}

function showHelp() {
    console.log(`
Usage:
  node intercom.js --ip <IP_ADDRESS> [options]

Optional parameters:
  --port <number>   RTSP Port (Default: 554)
  --file <path>     Audio file path (Default: music.mp3)
  --rate <number>   Sample rate (Default: 8000). Try 16000 if audio is slow.
  --vol  <number>   Volume from 0.1 to 2.0 (Default: 0.5)

Example:
  node intercom.js --ip 192.168.1.100 --file notification.wav --rate 16000
    `);
}

// --- CONFIG FROM ARGUMENTS ---
const config = parseArgs();

console.log('------------------------------------------');
console.log(`Target IP:   ${config.ip}`);
console.log(`Port:        ${config.port}`);
console.log(`Audio File:  ${config.file}`);
console.log(`Sample Rate: ${config.rate} Hz`);
console.log(`Volume:      ${config.volume}`);
console.log('------------------------------------------');

// Fixed technical configuration (Based on successful test results)
const CHUNK_SIZE = 320;
// Header Length is always fixed for 320 bytes payload structure
// 320 (data) + 12 (padding) = 332
const FRAME_LEN = 332;

// Buffer & Speed Tuning
const MAX_BUFFER_AHEAD_MS = 2000;
const SPEED_MULTIPLIER = 1.3;

const client = new net.Socket();
let audioQueue = [];
let startTime = 0;
let totalBytesSent = 0;
let isThrottling = false;

// --- CONNECTION ---
client.connect(config.port, config.ip, () => {
    client.setNoDelay(true);
    console.log('>>> Connecting and sending OPEN command...');

    const openCmd = `USER_CMD_SET rtsp://${config.ip}/onvif0 RTSP/1.0\r\n` +
        `CSeq: 8\r\n` +
        `Content-length: strlen(Content-type)\r\n` +
        `Content-type: AudioCtlCmd:OPEN\r\n\r\n`;
    client.write(openCmd);
});

client.on('data', (data) => {
    console.log(data.toString())
    if (data.toString().includes('CSeq: 8')) {
        console.log('>>> Camera accepted. Streaming...');
        startStreaming();
    }
});

client.on('error', (err) => {
    console.error(`!!! Connection error: ${err.message}`);
    process.exit(1);
});

function startStreaming() {
    const ffmpeg = spawn('ffmpeg', [
        '-i', config.file,
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        '-ar', config.rate.toString(), // Use rate from arguments
        '-ac', '1',
        '-filter:a', `volume=${config.volume}`,
        'pipe:1'
    ]);

    ffmpeg.stdout.on('data', (chunk) => {
        for (let i = 0; i < chunk.length; i += CHUNK_SIZE) {
            const subChunk = chunk.slice(i, i + CHUNK_SIZE);
            if (subChunk.length === CHUNK_SIZE) audioQueue.push(subChunk);
        }
        if (!isThrottling) processQueue();
    });

    ffmpeg.on('close', () => console.log('>>> Finished reading audio file.'));

    // Catch error if file does not exist or ffmpeg error
    ffmpeg.stderr.on('data', (data) => {
        // Only show critical errors
        const msg = data.toString();
        if (msg.includes('No such file') || msg.includes('Error')) {
            console.error(`FFmpeg Error: ${msg}`);
        }
    });
}

function processQueue() {
    isThrottling = true;

    if (audioQueue.length === 0) {
        isThrottling = false;
        return;
    }

    if (startTime === 0) {
        // BURST first 1 second (based on sample rate)
        // Rate 8000 -> 16000 bytes/s -> ~50 packets (320 bytes)
        // Rate 16000 -> 32000 bytes/s -> ~100 packets
        const burstPackets = Math.floor(config.rate * 2 / CHUNK_SIZE);

        if (audioQueue.length > burstPackets) {
            console.log(`>>> Bursting ${burstPackets} packets...`);
            for (let i = 0; i < burstPackets; i++) {
                sendRtspFrame(audioQueue.shift());
            }
            startTime = Date.now();
        } else {
            isThrottling = false;
            return;
        }
    }

    const timeElapsed = Date.now() - startTime;

    // Calculate based on dynamic sample rate
    // Bytes per second = Rate * 2 (16-bit)
    const bytesPerSecond = config.rate * 2;
    const audioTimeSentAdjusted = ((totalBytesSent / bytesPerSecond) * 1000) / SPEED_MULTIPLIER;

    if (audioTimeSentAdjusted > timeElapsed + MAX_BUFFER_AHEAD_MS) {
        setTimeout(processQueue, 10);
        return;
    }

    const chunk = audioQueue.shift();
    sendRtspFrame(chunk);
    setImmediate(processQueue);
}

function sendRtspFrame(chunk) {
    const header = Buffer.alloc(4);
    header[0] = 0x24; // $
    header[1] = 0x02; // Channel 2
    header.writeUInt16LE(FRAME_LEN, 2);

    const padding = Buffer.alloc(12, 0);
    client.write(Buffer.concat([header, padding, chunk]));
    totalBytesSent += chunk.length;
}

// Handle stop
process.on('SIGINT', () => {
    console.log('\n>>> Disconnecting...');
    const closeCmd = `USER_CMD_SET rtsp://${config.ip}/onvif1 RTSP/1.0\r\n` +
        `CSeq: 10\r\n` +
        `Content-length: strlen(Content-type)\r\n` +
        `Content-type: AudioCtlCmd:CLOSE\r\n\r\n`;

    if (client.writable) client.write(closeCmd);
    setTimeout(() => {
        client.destroy();
        process.exit();
    }, 50);
});