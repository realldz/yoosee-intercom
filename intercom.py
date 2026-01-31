import argparse
import socket
import struct
import subprocess
import time
import threading
import sys
import collections

# Fixed configuration
CHUNK_SIZE = 320
FRAME_LEN = 332
MAX_BUFFER_AHEAD_MS = 2000
SPEED_MULTIPLIER = 1.0

# Queue limit for unconnected clients (approx 50 mins of audio)
MAX_QUEUE_SIZE_UNCONNECTED = 50000 

class CameraClient:
    def __init__(self, ip, port, sample_rate, debug=False):
        self.ip = ip
        self.port = port
        self.sample_rate = sample_rate
        self.debug = debug
        self.sock = None
        self.audio_queue = collections.deque()
        self.start_time = 0
        self.total_bytes_sent = 0
        self.is_connected = False
        self.running = True
        
        # Thread for processing queue
        self.thread = threading.Thread(target=self._process_queue_loop, daemon=True)
        self.thread.start()
        
        # Connect immediately
        self.connect()

    def log_debug(self, msg):
        if self.debug:
            print(f"[DEBUG][{self.ip}] {msg}")

    def connect(self):
        print(f"[{self.ip}] Connecting...")
        self.log_debug(f"Connecting to {self.ip}:{self.port}...")
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.settimeout(10.0) # 10s timeout for initial connection
            self.sock.connect((self.ip, self.port))
            
            # Send OPEN command
            open_cmd = (
                f"USER_CMD_SET rtsp://{self.ip}/onvif0 RTSP/1.0\r\n"
                "CSeq: 8\r\n"
                "Content-length: strlen(Content-type)\r\n"
                "Content-type: AudioCtlCmd:OPEN\r\n\r\n"
            )
            self.sock.sendall(open_cmd.encode())
            self.log_debug("Sent OPEN command")
            
            # Start listener thread
            listener = threading.Thread(target=self._listen, daemon=True)
            listener.start()
            
        except Exception as e:
            print(f"[{self.ip}] !!! Connection error: {e}")
            self.stop()

    def _listen(self):
        try:
            while self.running and self.sock:
                data = self.sock.recv(4096)
                if not data:
                    break
                    
                msg = data.decode('utf-8', errors='ignore')
                if self.debug:
                    self.log_debug(f"RX Data: {msg.strip()}")
                
                if "CSeq: 8" in msg:
                    print(f"[{self.ip}] >>> Camera accepted. Ready to stream.")
                    self.is_connected = True
                    self.sock.settimeout(None) # Disable timeout for streaming
        except Exception as e:
            if self.running:
                print(f"[{self.ip}] Listener error: {e}")
            self.is_connected = False

    def enqueue(self, chunk):
        # Buffer data even if not yet connected
        self.audio_queue.append(chunk)

        # Prevent memory leak
        if not self.is_connected and len(self.audio_queue) > MAX_QUEUE_SIZE_UNCONNECTED:
            self.audio_queue.popleft()
            self.log_debug("Queue full (not connected). Dropped oldest packet.")
            
        # Logging queue size mostly adds noise, so omitted unless strictly debugging queue
        # self.log_debug(f"Enqueued. Size: {len(self.audio_queue)}")

    def _process_queue_loop(self):
        while self.running:
            if not self.is_connected or not self.sock:
                time.sleep(0.1)
                continue
                
            if not self.audio_queue:
                time.sleep(0.01)
                continue

            # BURST LOGIC
            if self.start_time == 0:
                burst_packets = int((self.sample_rate * 2) / CHUNK_SIZE)
                if len(self.audio_queue) > burst_packets:
                    print(f"[{self.ip}] >>> Bursting {burst_packets} packets...")
                    for _ in range(burst_packets):
                        if self.audio_queue:
                            self._send_rtsp_frame(self.audio_queue.popleft())
                    self.start_time = time.time() * 1000 # MS
                else:
                    self.log_debug(f"Buffering... Current: {len(self.audio_queue)}, Need: {burst_packets}")
                    time.sleep(0.1)
                    continue

            # THROTTLING LOGIC
            time_elapsed = (time.time() * 1000) - self.start_time
            bytes_per_second = self.sample_rate * 2
            # Calculate how much audio duration we have sent
            audio_time_sent_adj = ((self.total_bytes_sent / bytes_per_second) * 1000) / SPEED_MULTIPLIER
            
            if audio_time_sent_adj > time_elapsed + MAX_BUFFER_AHEAD_MS:
                # Buffer full, wait a bit
                time.sleep(0.01)
                continue
                
            if self.audio_queue:
                self._send_rtsp_frame(self.audio_queue.popleft())
            
            # Tiny sleep to yield CPU if needed, but not strictly required
            # time.sleep(0) 

    def _send_rtsp_frame(self, chunk):
        if not self.sock: return
        
        # $ + Channel(2) + Length(Little Endian)
        header = struct.pack('<BBH', 0x24, 0x02, FRAME_LEN)
        padding = b'\x00' * 12
        
        try:
            self.sock.sendall(header + padding + chunk)
            self.total_bytes_sent += len(chunk)
        except Exception as e:
            print(f"[{self.ip}] Write error: {e}")

    def stop(self):
        if not self.running: return
        self.running = False
        print(f"[{self.ip}] >>> Disconnecting...")
        
        if self.sock:
            try:
                close_cmd = (
                    f"USER_CMD_SET rtsp://{self.ip}/onvif1 RTSP/1.0\r\n"
                    "CSeq: 10\r\n"
                    "Content-length: strlen(Content-type)\r\n"
                    "Content-type: AudioCtlCmd:CLOSE\r\n\r\n"
                )
                self.sock.sendall(close_cmd.encode())
            except:
                pass
            
            time.sleep(0.05)
            self.sock.close()
            self.sock = None
        self.is_connected = False

def start_centralized_streaming(file_path, rate, volume, clients):
    print(f">>> Starting FFmpeg transcoding for {len(clients)} clients...")
    
    cmd = [
        'ffmpeg',
        '-v', 'error', # Suppress logs
        '-i', file_path,
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        '-ar', str(rate),
        '-ac', '1',
        '-filter:a', f'volume={volume}',
        'pipe:1'
    ]
    
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    # Check for immediate errors
    if process.poll() is not None:
         _, stderr = process.communicate()
         print(f"FFmpeg Error: {stderr.decode()}")
         return

    while True:
        chunk = process.stdout.read(CHUNK_SIZE)
        if not chunk:
            break
            
        # Pad last chunk if needed
        if len(chunk) < CHUNK_SIZE:
             chunk += b'\x00' * (CHUNK_SIZE - len(chunk))
             
        for client in clients:
            client.enqueue(chunk)
            
    print(">>> Finished reading audio file.")
    process.wait()

def parse_args():
    parser = argparse.ArgumentParser(description="YOOSEE CAMERA INTERCOM CLIENT (Python)")
    parser.add_argument('--ip', required=True, help="Camera IP address(es), comma-separated")
    parser.add_argument('--port', type=int, default=554, help="RTSP Port (Default: 554)")
    parser.add_argument('--file', default='music.mp3', help="Audio file path")
    parser.add_argument('--rate', type=int, default=8000, help="Sample rate (Hz)")
    parser.add_argument('--vol', type=float, default=0.5, help="Volume (0.0-2.0)")
    parser.add_argument('--debug', action='store_true', help="Enable debug logs")
    parser.add_argument('--auto-exit', action='store_true', help="Automatically exit when playback finishes")
    
    return parser.parse_args()

def main():
    args = parse_args()
    
    # Process multiple IPs
    ips_raw = args.ip.split(',')
    ips = [ip.strip() for ip in ips_raw if ip.strip()]
    ips = list(set(ips)) # Dedup
    
    print('------------------------------------------')
    print(f"Target IPs:  {', '.join(ips)}")
    print(f"Port:        {args.port}")
    print(f"Audio File:  {args.file}")
    print(f"Sample Rate: {args.rate} Hz")
    print(f"Volume:      {args.vol}")
    print(f"Debug Mode:  {'ON' if args.debug else 'OFF'}")
    print(f"Auto Exit:   {'ON' if args.auto_exit else 'OFF'}")
    print('------------------------------------------')
    
    clients = []
    for ip in ips:
        client = CameraClient(ip, args.port, args.rate, args.debug)
        clients.append(client)
        
    try:
        start_centralized_streaming(args.file, args.rate, args.vol, clients)
        
        # Keep running until user interrupt if clients are still streaming buffer
        # But usually we exit when file is done since this is a CLI tool. 
        # However, Node version relies on processQueue emptying itself (or not? Node version doesn't exit automatically when buffer empty unless we added that logic).
        # Node version waits for SIGINT or just keeps running. 
        # Here we just keep main thread alive or wait for Ctrl+C
        while any(len(c.audio_queue) > 0 for c in clients):
            time.sleep(0.5)
            
        print(">>> Buffer empty. Waiting for manual stop (Ctrl+C)...")
        if args.auto_exit:
            print(">>> Auto-exit enabled. Exiting in 2 seconds...")
            time.sleep(2)
            for client in clients:
                client.stop()
            sys.exit(0)

        while True:
            time.sleep(1)
            
    except KeyboardInterrupt:
        print("\n>>> Stopping all streams...")
        for client in clients:
            client.stop()
        sys.exit(0)

if __name__ == "__main__":
    main()
