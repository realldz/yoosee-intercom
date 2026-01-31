# Yoosee Camera Intercom Client (Node.js & Python)

A lightweight CLI tool (available in both **Node.js** and **Python**) to stream local audio files (MP3, WAV, etc.) to Yoosee and similar generic IP cameras via the RTSP backchannel.

This script implements a custom Smart Buffering algorithm to solve common stuttering issues caused by network jitter and firmware buffer underruns, while keeping latency manageable.

> [!WARNING]
> The **Node.js** version of this tool is now **DEPRECATED**. Please use the **Python** version (`intercom.py`) for all future deployments. It includes the latest features (e.g., auto-exit) and fixes.

## Features

- **RTSP Backchannel Support**: Uses the `USER_CMD_SET` method found in Yoosee firmware.
- **Smart Buffering**: Implements a "Burst & Maintain" strategy to prevent audio stuttering.
- **Auto-Transcoding**: Uses FFmpeg to convert any audio format to the specific PCM 16-bit Little Endian format required by the camera on the fly.
- **Volume Control**: Software-based gain control to prevent speaker clipping/static noise.
- **Zero Dependencies**: 
  - **Node.js version**: Uses only native modules.
  - **Python version**: Uses standard library (`socket`, `subprocess`, `threading`).

## Prerequisites

1. **Node.js**: Version 12 or higher.
2. **FFmpeg**: Must be installed and added to your system's PATH.
   - **Windows**: Download from ffmpeg.org and add text `bin` folder to Environment Variables.
   - **Linux**: `sudo apt install ffmpeg`
   - **macOS**: `brew install ffmpeg`
3. **Python (Optional)**: Version 3.x if you prefer to use the Python script.

## Installation

Clone this repository:

```bash
git clone https://github.com/realldz/yoosee-intercom.git
cd yoosee-intercom
```

(Optional) Place your audio file (e.g., `music.mp3`) in the folder.

## Usage (Node.js - DEPRECATED)

Run the script using Node.js. The only required argument is the camera's IP address.

### Basic Command

```bash
node intercom.js --ip 192.168.1.100
```

### Advanced Usage

```bash
node intercom.js --ip 192.168.1.100 --port 554 --file alert.wav --rate 16000 --vol 0.8
```

## Usage (Python)

The Python version (`intercom.py`) offers the exact same functionality with identical arguments.

### Basic Command

```bash
python intercom.py --ip 192.168.1.100
```

### Advanced Usage

```bash
python intercom.py --ip 192.168.1.100 --port 554 --file alert.wav --rate 16000 --vol 0.8
```

## Arguments

| Flag | Description | Default |
|------|-------------|---------|
| `--ip` | The local IP address of the camera. | Required |
| `--port` | The RTSP port of the camera. | 554 |
| `--file` | Path to the audio file to stream. | music.mp3 |
| `--rate` | Sample rate (Hz). Try 16000 if audio sounds slow. | 8000 |
| `--vol` | Volume multiplier (0.1 to 2.0). Lower if audio is distorted. | 0.5 |
| `--auto-exit` | (Python Only) Automatically exit when playback finishes. | False |

## How It Works (Technical Deep Dive)

This script works by emulating the specific, non-standard RTSP implementation used by Yoosee firmware.

### 1. The Handshake Quirk
Unlike standard RTSP which uses ANNOUNCE or SETUP for backchannels, these cameras use a custom command `USER_CMD_SET` with a specific header quirk:

```http
USER_CMD_SET rtsp://<IP>/onvif1 RTSP/1.0
CSeq: 8
Content-length: strlen(Content-type)  <-- The firmware expects this literal string!
Content-type: AudioCtlCmd:OPEN
```

### 2. Audio Formatting
The camera expects raw PCM audio. Through reverse engineering, the specific format was identified as:
- **Codec**: PCM Signed 16-bit Little Endian (s16le).
- **Channels**: Mono (1 channel).
- **Sample Rate**: Usually 8000Hz or 16000Hz depending on the model.

### 3. The Little Endian Header Trap
Standard RTSP interleaved frames use Big Endian for the payload length. However, this firmware expects Little Endian.

- **Standard RTSP**: `$` (0x24) + Channel + Length (Big Endian).
- **Yoosee RTSP**: `$` (0x24) + Channel + Length (Little Endian).

Example for a 332-byte packet:
- Standard: `24 02 01 4C`
- This Script: `24 02 4C 01`

### 4. Smart Buffering Logic (The "Anti-Stutter" Engine)
Sending audio packets strictly by the clock (e.g., every 20ms) often fails due to Node.js event loop jitter and network latency, causing the camera's internal buffer to run dry (stuttering).

This script uses a "Burst & Maintain" algorithm:
- **Initial Burst**: When streaming starts, it immediately sends ~1 second of audio to fill the camera's hardware buffer.
- **Speed Multiplier (1.05x)**: The script sends data slightly faster (5%) than real-time. This compensates for network overhead and clock drift.
- **Smart Throttling**: It calculates the theoretical time sent vs. actual time elapsed. If the buffer ahead exceeds the `MAX_BUFFER_AHEAD_MS` (default 2s), it pauses.

This ensures the camera always has data to play, resulting in smooth audio, while keeping the disconnect delay acceptable (~2 seconds).

## Troubleshooting

- **Audio is static/white noise**:
  - The sample rate might be wrong. Try `--rate 16000`.
  - The volume is too high, causing clipping. Try `--vol 0.2`.

- **Audio is stuttering**:
  - Network signal is weak.
  - Try increasing `MAX_BUFFER_AHEAD_MS` in the code.

- **Camera keeps playing after I stop the script**:
  - This is normal. The camera has a large internal buffer. The script sends a hard socket destroy command on exit (Ctrl+C) to minimize this, but 1-2 seconds of remaining audio is expected behavior for these devices.

## Disclaimer

This software is for educational and research purposes only. It is intended for use with devices you own or have permission to control. The author is not responsible for any misuse or damage caused by this software.