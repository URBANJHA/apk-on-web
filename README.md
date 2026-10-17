# Cloud APK Runner

Upload an APK in your browser and run it on a **server-side Android** (Redroid in Docker).
Your laptop only shows the screen and sends taps; the app runs on the server.

```
Browser  <--WebSocket-->  Node server  <--ADB-->  Redroid (Android in Docker)
```

## Requirements
- A **Linux** server or VPS (Ubuntu 22.04+ recommended) with Docker and Docker Compose
- Kernel with binder support. On Ubuntu:
  ```bash
  sudo apt install linux-modules-extra-$(uname -r)
  sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
  ```
- Roughly 2-4 GB RAM free per Android instance

> Redroid does not run on Windows or macOS Docker Desktop directly. Use a Linux VPS or a Linux VM.

## Run
```bash
cp .env.example .env      # then edit ACCESS_TOKEN
docker compose up -d --build
```
Open `http://SERVER_IP:3000`, enter your token, press Connect, upload an APK.

## Features
- Upload and install APK (`adb install`)
- List, open and remove installed apps
- Live screen (screenshot streaming, ~5-8 fps)
- Tap, swipe, Back, Home, Recent apps

## Security (read this)
- Always set a strong `ACCESS_TOKEN`; the server installs arbitrary APKs.
- Put it behind HTTPS (Caddy or Nginx) before exposing it to the internet.
- ADB port 5555 is intentionally not published outside Docker.
- For multi-user use, run **one container per user** and delete it after the session.

## Roadmap
- [ ] Per-user Android containers (spawn and destroy per session)
- [ ] Faster streaming via scrcpy + WebRTC
- [ ] User login and session limits
- [ ] Keyboard input and clipboard
- [ ] File upload to device storage

## Legal
Run only APKs you have the right to use. Do not use this to run pirated or malicious apps.

## License
MIT
